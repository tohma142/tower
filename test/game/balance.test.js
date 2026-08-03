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
import {
  ICEBERG_HP,
  PHASE,
  TICK_MS,
  TOTAL_WAVES,
  TOWER_TYPES,
  hpScaleFor,
} from '../../src/shared/constants.js';
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
 * @param {number} [options.openWithFishers] Fishers bought before any defence, to model
 *   a player who thinks economy is free.
 * @returns {{ outcome: string | null, wave: number, icebergHp: number, leaks: number,
 *   towers: number, fishers: number }}
 */
function playGame({
  players,
  buyOrder = ['sniper', 'pistol'],
  towerLimit = Infinity,
  openWithFishers = 0,
}) {
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

  // Spend the opening budget on economy before anything else, to model the player who
  // thinks a Fisher is free money.
  for (let i = 0; i < openWithFishers; i += 1) {
    const tile = RANKED_TILES[RANKED_TILES.length - 1 - i];
    const bought = applyCommand(state, ids[0], {
      type: 'place',
      tileX: tile.x,
      tileY: tile.y,
      towerType: 'fisher',
    });
    if (bought.ok) used.add(`${tile.x},${tile.y}`);
  }

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
    fishers: state.towers.filter((t) => t.type === 'fisher').length,
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

describe('the Fisher is a trade, not a free win', () => {
  it('loses the game when bought instead of an opening defence', () => {
    // The measured failure mode this guards against is the opposite of the obvious one.
    // A Fisher is not overpowered — it is a real cost, and spending the opening budget
    // on economy at 25 iceberg hit points loses on wave 2. If a future income or price
    // change ever makes opening with Fishers *survivable*, the unit has become free
    // money and this test should be the thing that says so.
    const result = playGame({ players: 1, openWithFishers: 1 });

    assert.equal(result.outcome, 'loss', 'opening on economy must not be safe');
    assert.ok(result.wave < 5, `died on wave ${result.wave}, expected an early collapse`);
  });

  it('does not change the reference build, which never buys one', () => {
    // Pins the claim that this feature retuned nothing: the guard's build order is
    // sniper-then-pistol, so every winnability assertion above measures the same game it
    // measured before Fishers existed.
    const result = playGame({ players: 1 });

    assert.equal(result.outcome, 'win');
    assert.equal(result.fishers, 0, 'the reference build must not have bought a Fisher');
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

describe('the opening is survivable', () => {
  it('lets one player clear wave 1 with the three Pistols they can afford', () => {
    // The opening is not a choice: STARTING_FISH buys exactly three Pistols, so this is
    // what a solo player has on wave 1. Three Pistols are 18 damage per second against
    // six 50-hit-point walkers, and at the original 900ms spacing they killed four of
    // six *however well they were placed* — wave 1 was lost before it was played.
    //
    // Placement is stated because it decides the result: these are the three
    // highest-coverage tiles, i.e. the reference player's judgement. A left-to-right
    // scan still leaks, and that is intended — where you build is meant to matter.
    const state = createGameState();
    addPlayer(state, 'p1', 'Solo');
    startGame(state);

    const budget = state.players.get('p1')?.fish ?? 0;
    const pistol = TOWER_TYPES.pistol;
    assert.equal(
      Math.floor(budget / pistol.cost),
      3,
      'the opening budget is no longer three Pistols — this test is measuring the wrong thing',
    );

    for (const tile of tilesByCoverage(pistol.range).slice(0, 3)) {
      const placed = applyCommand(state, 'p1', {
        type: 'place',
        tileX: tile.x,
        tileY: tile.y,
        towerType: 'pistol',
      });
      assert.equal(placed.ok, true, `could not place on (${tile.x},${tile.y})`);
    }
    assert.equal(state.towers.length, 3, 'the build under test was not actually made');
    assert.equal(state.players.get('p1')?.fish, budget - 3 * pistol.cost);

    startWave(state);
    for (let i = 0; i < 40_000 && state.phase === PHASE.WAVE; i += 1) tick(state, TICK_MS);

    assert.equal(state.phase, PHASE.BUILD, 'wave 1 never ended');
    assert.equal(state.leaks, 0, `wave 1 leaked ${state.leaks} of 6 walkers past three Pistols`);
    assert.equal(state.icebergHp, ICEBERG_HP, 'the iceberg took damage on the teaching wave');
  });

  it('still punishes a solo opening built without regard to the path', () => {
    // The other half of the contract. Wave 1 being clearable must not mean it clears
    // itself: three Pistols dropped on the first buildable tiles by a left-to-right scan
    // should still leak, or placement has stopped being a decision.
    const state = createGameState();
    addPlayer(state, 'p1', 'Solo');
    startGame(state);

    let placed = 0;
    for (let x = 0; x < 20 && placed < 3; x += 1) {
      for (let y = 0; y < 12 && placed < 3; y += 1) {
        if (!isBuildable(x, y)) continue;
        if (applyCommand(state, 'p1', { type: 'place', tileX: x, tileY: y, towerType: 'pistol' }).ok) {
          placed += 1;
        }
      }
    }
    assert.equal(placed, 3, 'the careless build under test was not actually made');

    startWave(state);
    for (let i = 0; i < 40_000 && state.phase === PHASE.WAVE; i += 1) tick(state, TICK_MS);

    assert.ok(state.leaks > 0, 'a build ignoring the path held wave 1 — placement stopped mattering');
  });
});
