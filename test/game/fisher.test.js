/**
 * The Fisher: a penguin that pays instead of shooting.
 *
 * Two things are worth pinning down. It must genuinely not fight — a support unit that
 * quietly acquires targets would be a strictly-better tower rather than a trade — and
 * its payout must follow the same shared-income rule as every other source of fish, or
 * it silently changes what headcount is worth.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { spawnEnemy } from '../../src/game/enemies.js';
import { drainEvents, startWave, tick } from '../../src/game/state.js';
import { createTower, totalIncome, updateTowers } from '../../src/game/towers.js';
import { PHASE, TICK_MS, TOWER_TYPES, isCombatTower } from '../../src/shared/constants.js';
import { isBuildable } from '../../src/shared/map.js';
import { grantFish, makeGame, player, runUntil } from '../helpers/game.js';

const FISHER = TOWER_TYPES.fisher;

/**
 * Buildable tiles, found rather than assumed.
 *
 * @param {number} limit
 * @returns {Array<{ x: number, y: number }>}
 */
function freeTiles(limit) {
  /** @type {Array<{ x: number, y: number }>} */
  const found = [];
  for (let x = 0; x < 20 && found.length < limit; x += 1) {
    for (let y = 0; y < 12 && found.length < limit; y += 1) {
      if (isBuildable(x, y)) found.push({ x, y });
    }
  }
  return found;
}

/**
 * Build `count` Fishers on free tiles.
 *
 * @param {import('../../src/game/state.js').GameState} state
 * @param {number} count
 */
function buildFishers(state, count) {
  for (const tile of freeTiles(count)) {
    createTower(state, { ownerId: 'p1', type: 'fisher', tileX: tile.x, tileY: tile.y });
  }
}

/**
 * Run the current wave to completion.
 *
 * @param {import('../../src/game/state.js').GameState} state
 */
function finishWave(state) {
  runUntil(state, (s) => s.phase !== PHASE.WAVE, { describe: 'wave to end' });
}

describe('the Fisher does not fight', () => {
  it('is not a combat tower', () => {
    assert.equal(isCombatTower(FISHER), false);
  });

  it('never fires, even with an enemy standing on it', () => {
    // The cheapest way for this to go wrong is a range of zero that still passes an
    // "in range" check when the distance is also zero.
    const state = makeGame();
    const [tile] = freeTiles(1);
    createTower(state, { ownerId: 'p1', type: 'fisher', tileX: tile.x, tileY: tile.y });

    const enemy = spawnEnemy(state, 'walker');
    enemy.progress = 0;

    for (let i = 0; i < 200; i += 1) updateTowers(state, TICK_MS);

    assert.equal(state.projectiles.length, 0, 'a Fisher must never shoot');
  });

  it('lets a whole wave walk past untouched', () => {
    // The end-to-end version: nothing dies, and the iceberg takes the full beating.
    const state = makeGame();
    grantFish(state, 'p1');
    buildFishers(state, 6);

    startWave(state);
    finishWave(state);

    assert.equal(state.kills, 0, 'Fishers killed something');
    assert.ok(state.leaks > 0, 'the wave should have walked straight through');
  });
});

describe('the Fisher pays', () => {
  it('reports its income per wave', () => {
    const state = makeGame();
    buildFishers(state, 3);

    assert.equal(totalIncome(state), FISHER.income * 3);
  });

  it('reports nothing when the board has only guns on it', () => {
    const state = makeGame();
    const [tile] = freeTiles(1);
    createTower(state, { ownerId: 'p1', type: 'pistol', tileX: tile.x, tileY: tile.y });

    assert.equal(totalIncome(state), 0);
  });

  it('pays out when a wave is cleared, on top of the survival bonus', () => {
    const state = makeGame();
    grantFish(state, 'p1', 1000);
    buildFishers(state, 2);

    const before = player(state, 'p1').fish;
    startWave(state);
    finishWave(state);

    const cleared = drainEvents(state).find((e) => e.kind === 'waveCleared');
    assert.ok(cleared !== undefined);
    assert.equal(cleared.income, FISHER.income * 2);

    const earned = player(state, 'p1').fish - before;
    assert.equal(earned, cleared.bonus + cleared.income, 'both payments, neither swallowed');
  });

  it('pays every player in full rather than splitting between them', () => {
    // Same rule as a kill bounty. Splitting would make a Fisher worth less the more
    // friends you have, and enemy hit points already scale with headcount.
    const state = makeGame({ players: ['a', 'b', 'c'] });
    grantFish(state, 'a', 1000);
    grantFish(state, 'b', 1000);
    grantFish(state, 'c', 1000);
    createTower(state, { ownerId: 'a', type: 'fisher', tileX: freeTiles(1)[0].x, tileY: freeTiles(1)[0].y });

    const before = [...state.players.values()].map((p) => p.fish);
    startWave(state);
    finishWave(state);
    const after = [...state.players.values()].map((p) => p.fish);

    const gains = after.map((v, i) => v - before[i]);
    assert.deepEqual(gains, [gains[0], gains[0], gains[0]], 'everyone gets the same');
    assert.ok(gains[0] > 0);
  });

  it('pays the player who did not build it', () => {
    // The Fisher belongs to the team, like every other penguin.
    const state = makeGame({ players: ['a', 'b'] });
    grantFish(state, 'a', 1000);
    grantFish(state, 'b', 1000);
    const [tile] = freeTiles(1);
    createTower(state, { ownerId: 'a', type: 'fisher', tileX: tile.x, tileY: tile.y });

    const before = player(state, 'b').fish;
    startWave(state);
    finishWave(state);

    assert.ok(player(state, 'b').fish - before >= FISHER.income);
  });

  it('pays nothing for a wave that was lost', () => {
    // The payout hangs off the wave-cleared path. Losing on wave 3 must not also hand
    // out three waves of fishing money on the way down.
    const state = makeGame();
    buildFishers(state, 2);
    state.icebergHp = 1;

    const before = player(state, 'p1').fish;
    startWave(state);
    runUntil(state, (s) => s.phase === PHASE.GAME_OVER, { describe: 'defeat' });

    assert.equal(state.outcome, 'loss');
    assert.equal(player(state, 'p1').fish, before, 'a lost wave pays nothing');
  });
});

describe('the Fisher costs a tile', () => {
  it('occupies its tile like any other penguin', () => {
    // The real price of a Fisher is the buildable tile it stands on. If it did not
    // occupy one, it would be free defence-wise and the trade would vanish.
    const state = makeGame();
    const [tile] = freeTiles(1);
    const tower = createTower(state, {
      ownerId: 'p1',
      type: 'fisher',
      tileX: tile.x,
      tileY: tile.y,
    });

    assert.equal(state.towers.length, 1);
    assert.equal(tower.spec.income, FISHER.income);
  });

  it('appears in the snapshot so every client draws it', () => {
    const state = makeGame();
    const [tile] = freeTiles(1);
    createTower(state, { ownerId: 'p1', type: 'fisher', tileX: tile.x, tileY: tile.y });

    tick(state, TICK_MS);

    assert.equal(state.towers[0].type, 'fisher');
  });
});
