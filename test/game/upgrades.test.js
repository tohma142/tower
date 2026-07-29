/**
 * Upgrading a placed penguin.
 *
 * The property that carries the most weight here is that an upgrade actually reaches the
 * projectile. Damage is captured when a shot is created, so a version of this feature
 * that raised `tower.level` and nothing else would look completely correct in the UI,
 * pass every command-level test, and change nothing about the game.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyCommand } from '../../src/game/commands.js';
import { spawnEnemy } from '../../src/game/enemies.js';
import { drainEvents, startWave } from '../../src/game/state.js';
import { totalIncome, towerDamage, updateTowers } from '../../src/game/towers.js';
import {
  MAX_TOWER_LEVEL,
  PHASE,
  TICK_MS,
  TOWER_TYPES,
  TOWER_TYPE_IDS,
  levelMultiplier,
  upgradeCostFor,
} from '../../src/shared/constants.js';
import { isBuildable } from '../../src/shared/map.js';
import { REJECT_REASON } from '../../src/shared/protocol.js';
import { grantFish, makeGame, player, rejection } from '../helpers/game.js';

const TILE = (() => {
  for (let x = 0; x < 20; x += 1) {
    for (let y = 0; y < 12; y += 1) {
      if (isBuildable(x, y)) return { x, y };
    }
  }
  throw new Error('no buildable tile on the map');
})();

/**
 * A game with one placed penguin and money to spare.
 *
 * @param {string} [type]
 * @param {string[]} [players]
 * @returns {import('../../src/game/state.js').GameState}
 */
function gameWithTower(type = 'pistol', players = ['p1']) {
  const state = makeGame({ players });
  for (const id of players) grantFish(state, id);

  // Placed through the command layer, not createTower directly: the command is what
  // registers the tile in `occupancy`, and every upgrade looks the penguin up by tile.
  const placed = applyCommand(state, players[0], {
    type: 'place',
    tileX: TILE.x,
    tileY: TILE.y,
    towerType: type,
  });
  assert.equal(placed.ok, true, `setup placement of a ${type} failed`);

  return state;
}

/**
 * @param {import('../../src/game/state.js').GameState} state
 * @param {string} playerId
 * @param {{ x: number, y: number }} [tile]
 */
function upgrade(state, playerId, tile = TILE) {
  return applyCommand(state, playerId, { type: 'upgrade', tileX: tile.x, tileY: tile.y });
}

describe('upgrading changes the game, not just the number', () => {
  it('raises the damage a shot actually carries', () => {
    // The whole feature in one assertion. A version that raised the level and forgot to
    // thread it into createProjectile would pass everything else in this file.
    const state = gameWithTower('sniper');
    const enemy = spawnEnemy(state, 'brute');
    enemy.progress = 0;

    updateTowers(state, TICK_MS);
    const baseDamage = state.projectiles[0].damage;
    state.projectiles = [];

    upgrade(state, 'p1');
    state.towers[0].cooldownMs = 0;
    updateTowers(state, TICK_MS);

    assert.equal(state.projectiles[0].damage, baseDamage * levelMultiplier(2));
    assert.ok(state.projectiles[0].damage > baseDamage, 'an upgrade must do something');
  });

  it('raises a Fisher payout instead of its damage', () => {
    // One multiplier table covers both, so a unit that does not shoot still benefits.
    const state = gameWithTower('fisher');
    const before = totalIncome(state);

    upgrade(state, 'p1');

    assert.equal(totalIncome(state), before * levelMultiplier(2));
  });

  it('leaves a Fisher unable to shoot no matter how far it is upgraded', () => {
    const state = gameWithTower('fisher');
    spawnEnemy(state, 'walker');

    while (state.towers[0].level < MAX_TOWER_LEVEL) upgrade(state, 'p1');
    for (let i = 0; i < 100; i += 1) updateTowers(state, TICK_MS);

    assert.equal(state.towers[0].level, MAX_TOWER_LEVEL);
    assert.equal(state.projectiles.length, 0, 'upgrades must not grow a weapon');
  });

  it('scales output for every tower type, not just the one tested by hand', () => {
    for (const id of TOWER_TYPE_IDS) {
      const state = gameWithTower(id);
      const tower = state.towers[0];
      const base = TOWER_TYPES[id];

      upgrade(state, 'p1');

      if (base.damage > 0) {
        assert.equal(towerDamage(tower), base.damage * levelMultiplier(2), id);
      } else {
        assert.equal(totalIncome(state), base.income * levelMultiplier(2), id);
      }
    }
  });
});

describe('the price of an upgrade', () => {
  it('charges exactly what the table says, once', () => {
    const state = gameWithTower('sniper');
    const cost = upgradeCostFor(TOWER_TYPES.sniper, 1);
    const before = player(state, 'p1').fish;

    upgrade(state, 'p1');

    assert.equal(player(state, 'p1').fish, before - cost);
  });

  it('gets more expensive at each level', () => {
    for (const id of TOWER_TYPE_IDS) {
      const spec = TOWER_TYPES[id];
      for (let level = 1; level < MAX_TOWER_LEVEL - 1; level += 1) {
        assert.ok(
          upgradeCostFor(spec, level + 1) > upgradeCostFor(spec, level),
          `${id} level ${level + 1} must cost more than level ${level}`,
        );
      }
    }
  });

  it('adds to the total invested, so a later sale values the upgrades', () => {
    const state = gameWithTower('sniper');
    const cost = upgradeCostFor(TOWER_TYPES.sniper, 1);

    upgrade(state, 'p1');

    assert.equal(state.towers[0].invested, TOWER_TYPES.sniper.cost + cost);
  });

  it('reports an impossible price past the cap rather than a cheap one', () => {
    // Infinity rather than 0 or NaN: an unguarded caller then fails to afford it, which
    // is a refusal, instead of silently upgrading past the end of the table.
    assert.equal(upgradeCostFor(TOWER_TYPES.pistol, MAX_TOWER_LEVEL), Infinity);
  });

  it('charges the player who clicked, not the player who built it', () => {
    const state = gameWithTower('pistol', ['a', 'b']);
    const bBefore = player(state, 'b').fish;
    const aBefore = player(state, 'a').fish;

    assert.equal(upgrade(state, 'b').ok, true);

    assert.ok(player(state, 'b').fish < bBefore, 'the clicker pays');
    assert.equal(player(state, 'a').fish, aBefore, 'the owner does not');
  });
});

describe('the level cap', () => {
  it('stops at MAX_TOWER_LEVEL', () => {
    const state = gameWithTower('pistol');

    for (let i = 0; i < MAX_TOWER_LEVEL + 3; i += 1) upgrade(state, 'p1');

    assert.equal(state.towers[0].level, MAX_TOWER_LEVEL);
  });

  it('refuses with a reason that names the cap, not the price', () => {
    // Telling a player they cannot afford something that was never for sale sends them
    // off to earn money that will not help.
    const state = gameWithTower('pistol');
    while (state.towers[0].level < MAX_TOWER_LEVEL) upgrade(state, 'p1');

    assert.equal(rejection(upgrade(state, 'p1')), REJECT_REASON.ALREADY_MAX_LEVEL);
  });

  it('takes no money for a refused upgrade at the cap', () => {
    const state = gameWithTower('pistol');
    while (state.towers[0].level < MAX_TOWER_LEVEL) upgrade(state, 'p1');
    const before = player(state, 'p1').fish;

    upgrade(state, 'p1');

    assert.equal(player(state, 'p1').fish, before);
  });
});

describe('upgrade rejections', () => {
  it('refuses when the player cannot afford it, without changing the level', () => {
    const state = gameWithTower('sniper');
    player(state, 'p1').fish = 0;

    assert.equal(rejection(upgrade(state, 'p1')), REJECT_REASON.INSUFFICIENT_FISH);
    assert.equal(state.towers[0].level, 1, 'a refused upgrade must not apply');
  });

  it('refuses a tile with no penguin on it', () => {
    const state = makeGame();
    grantFish(state, 'p1');

    assert.equal(rejection(upgrade(state, 'p1')), REJECT_REASON.NO_TOWER_HERE);
  });

  it('refuses a tile off the board', () => {
    const state = gameWithTower();

    assert.equal(
      rejection(upgrade(state, 'p1', { x: -1, y: 0 })),
      REJECT_REASON.OUT_OF_BOUNDS,
    );
  });

  it('refuses someone who is not seated', () => {
    const state = gameWithTower();

    assert.equal(rejection(upgrade(state, 'ghost')), REJECT_REASON.NOT_A_PLAYER);
  });

  it('refuses once the game is over', () => {
    const state = gameWithTower();
    state.phase = PHASE.GAME_OVER;

    assert.equal(rejection(upgrade(state, 'p1')), REJECT_REASON.WRONG_PHASE);
  });
});

describe('upgrading mid-wave', () => {
  it('is allowed, matching placement', () => {
    const state = gameWithTower('pistol');
    startWave(state);
    assert.equal(state.phase, PHASE.WAVE);

    assert.equal(upgrade(state, 'p1').ok, true);
  });
});

describe('the team can see it happen', () => {
  it('announces the upgrade with its new level and price', () => {
    const state = gameWithTower('bomber');
    drainEvents(state);

    upgrade(state, 'p1');

    const event = drainEvents(state).find((e) => e.kind === 'towerUpgraded');
    assert.ok(event !== undefined, 'upgrades must be visible to everyone, not just the buyer');
    assert.equal(event.level, 2);
    assert.equal(event.cost, upgradeCostFor(TOWER_TYPES.bomber, 1));
    assert.equal(event.towerType, 'bomber');
  });
});
