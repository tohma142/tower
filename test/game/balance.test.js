/**
 * The balance guard.
 *
 * Difficulty is not something a unit test can assert — "fun" has no assertion. What
 * this file pins down is the *outer bounds*: that a competent build survives, that it
 * does not survive untouched, and that team size does not decide the outcome. Those are
 * the properties a careless edit to the tuning table breaks, and they are exactly the
 * ones nobody notices until wave 12 of a live game.
 *
 * These tests play whole games. They are affordable because the simulation is pure and
 * takes time as an argument — fifteen waves run in milliseconds with no timers.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyCommand } from '../../src/game/commands.js';
import {
  createGameState,
  addPlayer,
  drainEvents,
  startGame,
  startWave,
  tick,
} from '../../src/game/state.js';
import { ICEBERG_HP, PHASE, TICK_MS, TOTAL_WAVES, hpScaleFor } from '../../src/shared/constants.js';
import { PATH_LENGTH, isBuildable, positionAt } from '../../src/shared/map.js';

/**
 * Buildable tiles ranked by how much of the path they cover, best first.
 *
 * This is the reference player's judgement, and it stands in for "reasonable
 * placement". Ranking by coverage rather than scanning left to right matters enormously
 * — the same game is won or lost on that difference alone.
 *
 * @param {number} range Tiles.
 * @returns {Array<{ x: number, y: number }>}
 */
function tilesByCoverage(range) {
  /** @type {Array<{ x: number, y: number }>} */
  const samples = [];
  for (let d = 0; d <= PATH_LENGTH; d += 0.5) samples.push(positionAt(d));

  /** @type {Array<{ x: number, y: number, covered: number }>} */
  const scored = [];
  for (let x = 0; x < 20; x += 1) {
    for (let y = 0; y < 12; y += 1) {
      if (!isBuildable(x, y)) continue;
      const cx = x + 0.5;
      const cy = y + 0.5;
      const covered = samples.filter((p) => (p.x - cx) ** 2 + (p.y - cy) ** 2 <= range * range).length;
      if (covered > 0) scored.push({ x, y, covered });
    }
  }

  // Tie-break on position so the ordering is identical on every run.
  scored.sort((a, b) => (b.covered - a.covered) || (a.x - b.x) || (a.y - b.y));
  return scored.map(({ x, y }) => ({ x, y }));
}

const RANKED_TILES = tilesByCoverage(3);

/**
 * Play a full game with a reference player and report how it went.
 *
 * @param {object} options
 * @param {number} options.players
 * @param {ReadonlyArray<string>} [options.buyOrder] Preference order, strongest first.
 * @param {number} [options.towerLimit] Cap on penguins, to model a weak build.
 * @returns {{ outcome: string | null, wave: number, icebergHp: number, leaks: number, towers: number }}
 */
function playGame({ players, buyOrder = ['sniper', 'pistol'], towerLimit = Infinity }) {
  const state = createGameState();
  /** @type {string[]} */
  const ids = [];
  for (let i = 0; i < players; i += 1) {
    ids.push(`p${i}`);
    addPlayer(state, `p${i}`, `Penguin ${i + 1}`);
  }
  startGame(state);

  /** @type {Set<string>} */
  const used = new Set();

  /** Spend everyone down onto the best free tiles. */
  const spend = () => {
    let bought = true;
    while (bought && used.size < towerLimit) {
      bought = false;
      for (const id of ids) {
        if (used.size >= towerLimit) break;
        const tile = RANKED_TILES.find((t) => !used.has(`${t.x},${t.y}`));
        if (tile === undefined) return;

        for (const towerType of buyOrder) {
          const result = applyCommand(state, id, {
            type: 'place',
            tileX: tile.x,
            tileY: tile.y,
            towerType,
          });
          if (result.ok) {
            used.add(`${tile.x},${tile.y}`);
            bought = true;
            break;
          }
        }
      }
    }
  };

  // Bounded: a wave that never ends is a bug, and hanging the suite would hide it.
  let guard = 0;
  while (state.phase !== PHASE.GAME_OVER) {
    guard += 1;
    assert.ok(guard < 500_000, 'game failed to reach a conclusion');

    if (state.phase === PHASE.BUILD) {
      spend();
      startWave(state);
    }
    tick(state, TICK_MS);
    drainEvents(state);
  }

  return {
    outcome: state.outcome,
    wave: state.wave,
    icebergHp: state.icebergHp,
    leaks: state.leaks,
    towers: state.towers.length,
  };
}

describe('the game is winnable', () => {
  for (const players of [1, 2, 3, 4]) {
    it(`a competent ${players}-player team clears all ${TOTAL_WAVES} waves`, () => {
      const result = playGame({ players });

      assert.equal(
        result.outcome,
        'win',
        `${players}p lost on wave ${result.wave} with ${result.towers} penguins`,
      );
      assert.equal(result.wave, TOTAL_WAVES);
    });
  }
});

describe('the game is not trivial', () => {
  for (const players of [1, 2, 4]) {
    it(`a ${players}-player team does not finish untouched`, () => {
      // A flawless run at every team size is what the original tuning produced, and it
      // meant none of the placement decisions mattered.
      const result = playGame({ players });

      assert.ok(result.leaks > 0, `${players}p took zero leaks — nothing was at stake`);
      assert.ok(
        result.icebergHp < ICEBERG_HP,
        `${players}p finished on full health — the waves are not a threat`,
      );
    });
  }

  it('punishes a build that is too thin', () => {
    // The other bound. If five penguins can hold the line, the economy is pointless.
    const result = playGame({ players: 1, towerLimit: 5 });

    assert.equal(result.outcome, 'loss', 'five penguins should not hold fifteen waves');
    assert.ok(result.wave < TOTAL_WAVES);
  });
});

describe('team size does not decide the game', () => {
  it('leaves every team size in a comparable state at the end', () => {
    // Income is shared and wallets are per-player, so purchasing power scales linearly
    // with headcount; enemy hit points must scale the same way or bigger teams get a
    // structural advantage. This asserts the two actually cancel.
    const results = [1, 2, 4].map((players) => ({ players, ...playGame({ players }) }));

    const health = results.map((r) => r.icebergHp);
    const spread = Math.max(...health) - Math.min(...health);

    assert.ok(
      spread <= 30,
      `team size changed the outcome too much: ${results
        .map((r) => `${r.players}p=${Math.round(r.icebergHp)}`)
        .join(', ')}`,
    );
  });

  it('scales enemies exactly linearly with headcount', () => {
    // Anything shallower hands larger teams an advantage; the test above is the
    // consequence, this is the cause.
    for (let n = 1; n <= 4; n += 1) {
      assert.equal(hpScaleFor(n), n, `hpScaleFor(${n}) should equal ${n}`);
    }
  });
});

describe('the wave-clear bonus', () => {
  it('pays every player for surviving a wave', () => {
    const state = createGameState();
    addPlayer(state, 'a', 'Penguin 1');
    addPlayer(state, 'b', 'Penguin 2');
    startGame(state);

    const before = [...state.players.values()].map((p) => p.fish);

    // No penguins at all, so every enemy leaks and nothing is earned from kills. Give
    // the iceberg enough health to survive being walked over.
    state.icebergHp = 100_000;
    startWave(state);
    let guard = 0;
    while (state.phase === PHASE.WAVE) {
      guard += 1;
      assert.ok(guard < 500_000, 'wave never ended');
      tick(state, TICK_MS);
    }

    const after = [...state.players.values()].map((p) => p.fish);
    assert.ok(after[0] > before[0], 'clearing a wave must pay even with no kills');
    assert.deepEqual(after, [after[0], after[0]], 'both players get the same amount');
  });

  it('reports the payment in the waveCleared event', () => {
    // The client shows it, so it has to be on the wire rather than inferred.
    const state = createGameState();
    addPlayer(state, 'a', 'Penguin 1');
    startGame(state);
    state.icebergHp = 100_000;
    startWave(state);
    drainEvents(state);

    let guard = 0;
    while (state.phase === PHASE.WAVE) {
      guard += 1;
      assert.ok(guard < 500_000, 'wave never ended');
      tick(state, TICK_MS);
    }

    const cleared = drainEvents(state).find((e) => e.kind === 'waveCleared');
    assert.ok(cleared !== undefined);
    assert.ok(cleared.bonus > 0);
  });
});
