import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { spawnEnemy } from '../../src/game/enemies.js';
import {
  addPlayer,
  allPlayersReady,
  createGameState,
  drainEvents,
  playersNotReady,
  removePlayer,
  resetToLobby,
  setConnected,
  snapshot,
  startGame,
  startWave,
  tick,
} from '../../src/game/state.js';
import {
  ICEBERG_HP,
  PHASE,
  STARTING_FISH,
  TICK_MS,
  TOTAL_WAVES,
  hpScaleFor,
} from '../../src/shared/constants.js';
import { isBuildable } from '../../src/shared/map.js';
import { grantFish, makeGame, place, player, runTicks, runUntil } from '../helpers/game.js';

/**
 * Buildable tiles beside the path, for tests that need towers that actually shoot.
 *
 * @param {number} limit How many to return.
 * @returns {Array<{ x: number, y: number }>}
 */
function tilesNearPath(limit) {
  const found = [];
  for (let x = 0; x < 20 && found.length < limit; x += 1) {
    for (let y = 0; y < 12 && found.length < limit; y += 1) {
      if (isBuildable(x, y)) found.push({ x, y });
    }
  }
  return found;
}

describe('createGameState', () => {
  it('starts in the lobby with a full iceberg and no entities', () => {
    const state = createGameState();

    assert.equal(state.phase, PHASE.LOBBY);
    assert.equal(state.wave, 0);
    assert.equal(state.icebergHp, ICEBERG_HP);
    assert.deepEqual(state.enemies, []);
    assert.deepEqual(state.towers, []);
    assert.equal(state.outcome, null);
  });
});

describe('players', () => {
  it('seats a player with the starting fish', () => {
    const state = createGameState();
    const player = addPlayer(state, 'a', 'Penguin 1');

    assert.equal(player.fish, STARTING_FISH);
    assert.equal(player.connected, true);
    assert.equal(player.ready, false);
  });

  it('reconnecting the same id reclaims the seat rather than resetting it', () => {
    const state = createGameState();
    addPlayer(state, 'a', 'Penguin 1');
    player(state, 'a').fish = 999;
    setConnected(state, 'a', false);

    const rejoined = addPlayer(state, 'a', 'Penguin 1');

    assert.equal(rejoined.fish, 999, 'fish must survive a reconnect');
    assert.equal(rejoined.connected, true);
    assert.equal(state.players.size, 1);
  });

  it('clears the ready flag on disconnect', () => {
    const state = makeGame({ players: ['a'] });
    player(state, 'a').ready = true;

    setConnected(state, 'a', false);

    assert.equal(player(state, 'a').ready, false);
  });

  it('leaves a removed player\'s towers on the board', () => {
    // They were bought with shared effort; removing them mid-wave would punish the
    // players who are still here for someone else's dropout.
    const state = makeGame({ players: ['a'] });
    grantFish(state, 'a');
    const [tile] = tilesNearPath(1);
    place(state, 'a', tile.x, tile.y, 'pistol');

    removePlayer(state, 'a');

    assert.equal(state.players.size, 0);
    assert.equal(state.towers.length, 1, 'the penguin keeps defending');
  });
});

describe('ready gate', () => {
  it('requires every connected player', () => {
    const state = makeGame({ players: ['a', 'b'] });

    player(state, 'a').ready = true;
    assert.equal(allPlayersReady(state), false);

    player(state, 'b').ready = true;
    assert.equal(allPlayersReady(state), true);
  });

  it('excludes disconnected players so one dropout cannot stall the game', () => {
    // The gate has no timeout by design, so this exclusion is what keeps it from
    // deadlocking the moment someone's wifi blips.
    const state = makeGame({ players: ['a', 'b'] });
    player(state, 'a').ready = true;

    assert.equal(allPlayersReady(state), false);
    setConnected(state, 'b', false);
    assert.equal(allPlayersReady(state), true, 'the remaining player can proceed alone');
  });

  it('refuses to start with nobody connected', () => {
    const state = makeGame({ players: ['a'] });
    player(state, 'a').ready = true;
    setConnected(state, 'a', false);

    assert.equal(allPlayersReady(state), false, 'an empty room must not run waves');
  });

  it('names exactly who is being waited on', () => {
    // The only mitigation for an idle player stalling everyone is making it obvious.
    const state = makeGame({ players: ['a', 'b', 'c'] });
    player(state, 'a').ready = true;
    setConnected(state, 'c', false);

    assert.deepEqual(playersNotReady(state), ['Penguin 2']);
  });
});

describe('startGame', () => {
  it('fixes the hit-point scale from the connected headcount', () => {
    const state = createGameState();
    for (const id of ['a', 'b', 'c']) addPlayer(state, id, id);

    startGame(state);

    assert.equal(state.hpScale, hpScaleFor(3));
  });

  it('does not let a later disconnect retune a game in progress', () => {
    // Otherwise a team could make wave 15 easier by having someone pull the plug.
    const state = makeGame({ players: ['a', 'b', 'c', 'd'] });
    const scaleAtStart = state.hpScale;

    setConnected(state, 'd', false);
    removePlayer(state, 'd');

    assert.equal(state.hpScale, scaleAtStart);
  });

  it('resets fish, board, and outcome', () => {
    const state = makeGame({ players: ['a'] });
    player(state, 'a').fish = 5;
    state.icebergHp = 1;
    state.outcome = 'loss';

    startGame(state);

    assert.equal(player(state, 'a').fish, STARTING_FISH);
    assert.equal(state.icebergHp, ICEBERG_HP);
    assert.equal(state.outcome, null);
    assert.equal(state.phase, PHASE.BUILD);
  });
});

describe('startWave', () => {
  it('advances the wave counter and builds a schedule', () => {
    const state = makeGame();

    startWave(state);

    assert.equal(state.wave, 1);
    assert.equal(state.phase, PHASE.WAVE);
    assert.ok(state.schedule.length > 0);
    assert.equal(state.spawnIndex, 0);
  });

  it('clears ready flags so the next gate starts fresh', () => {
    const state = makeGame({ players: ['a', 'b'] });
    player(state, 'a').ready = true;
    player(state, 'b').ready = true;

    startWave(state);

    assert.equal(allPlayersReady(state), false);
  });

  it('refuses to start from a phase that is not the build phase', () => {
    const state = makeGame();
    startWave(state);

    assert.throws(() => startWave(state), /cannot start a wave/);
  });
});

describe('tick — spawning', () => {
  it('spawns nothing outside a wave', () => {
    const state = makeGame();
    runTicks(state, 100);

    assert.equal(state.enemies.length, 0);
  });

  it('spawns on the schedule, not all at once', () => {
    const state = makeGame();
    startWave(state);

    tick(state, TICK_MS);
    assert.equal(state.enemies.length, 1, 'first walker at 0ms');

    runTicks(state, 10); // 500ms — still before the 900ms second spawn
    assert.equal(state.enemies.length, 1);

    runTicks(state, 10); // past 900ms
    assert.equal(state.enemies.length, 2);
  });

  it('eventually spawns the whole wave exactly once', () => {
    const state = makeGame();
    startWave(state);
    const total = state.schedule.length;

    runUntil(state, (s) => s.spawnIndex >= total, { describe: 'all spawned' });

    assert.equal(state.spawnIndex, total);
    runTicks(state, 50);
    assert.equal(state.spawnIndex, total, 'must not spawn extras');
  });
});

describe('tick — wave completion', () => {
  it('returns to the build phase once the wave is cleared', () => {
    const state = makeGame();
    startWave(state);

    // No towers, so every enemy leaks. Give the iceberg enough health to survive it.
    state.icebergHp = 10_000;
    state.icebergMaxHp = 10_000;

    runUntil(state, (s) => s.phase === PHASE.BUILD, { describe: 'wave cleared' });

    assert.equal(state.phase, PHASE.BUILD);
    assert.equal(state.wave, 1);
    assert.equal(state.enemies.length, 0);
  });

  it('clears projectiles still in the air when a wave ends', () => {
    // Otherwise they hang frozen for the whole build phase, since the tick returns
    // early outside a wave.
    const state = makeGame();
    state.icebergHp = 10_000;
    startWave(state);
    runUntil(state, (s) => s.phase === PHASE.BUILD, { describe: 'wave cleared' });

    assert.deepEqual(state.projectiles, []);
  });

  it('emits a waveCleared event', () => {
    const state = makeGame();
    state.icebergHp = 10_000;
    startWave(state);
    drainEvents(state);

    runUntil(state, (s) => s.phase === PHASE.BUILD, { describe: 'wave cleared' });

    const events = drainEvents(state);
    assert.ok(events.some((e) => e.kind === 'waveCleared' && e.wave === 1));
  });
});

describe('tick — game over', () => {
  it('loses when the iceberg is destroyed', () => {
    const state = makeGame();
    state.icebergHp = 2;
    startWave(state);

    runUntil(state, (s) => s.phase === PHASE.GAME_OVER, { describe: 'defeat' });

    assert.equal(state.outcome, 'loss');
    assert.equal(state.icebergHp, 0);
  });

  it('clears the board on defeat', () => {
    const state = makeGame();
    state.icebergHp = 2;
    startWave(state);
    runUntil(state, (s) => s.phase === PHASE.GAME_OVER, { describe: 'defeat' });

    assert.deepEqual(state.enemies, []);
    assert.deepEqual(state.projectiles, []);
  });

  it('wins after the final wave is cleared', () => {
    const state = makeGame();
    state.phase = PHASE.BUILD;
    state.wave = TOTAL_WAVES - 1;
    startWave(state);

    assert.equal(state.wave, TOTAL_WAVES);

    // Force the wave to be finished: everything spawned, nothing left alive.
    state.spawnIndex = state.schedule.length;
    state.enemies = [];
    tick(state, TICK_MS);

    assert.equal(state.phase, PHASE.GAME_OVER);
    assert.equal(state.outcome, 'win');
  });

  it('prefers defeat over victory when both land on the same tick', () => {
    // A last enemy that reaches the iceberg and kills it is a loss, even though the
    // wave technically emptied at the same moment.
    const state = makeGame();
    state.phase = PHASE.BUILD;
    state.wave = TOTAL_WAVES - 1;
    startWave(state);
    state.spawnIndex = state.schedule.length;
    state.icebergHp = 1;

    const enemy = spawnEnemy(state, 'brute');
    enemy.progress = 10_000;
    tick(state, TICK_MS);

    assert.equal(state.outcome, 'loss');
  });

  it('stops simulating once the game is over', () => {
    const state = makeGame();
    state.icebergHp = 2;
    startWave(state);
    runUntil(state, (s) => s.phase === PHASE.GAME_OVER, { describe: 'defeat' });

    const waveAfter = state.wave;
    runTicks(state, 100);

    assert.equal(state.wave, waveAfter);
    assert.equal(state.enemies.length, 0);
  });
});

describe('resetToLobby', () => {
  it('clears the board and keeps the players seated', () => {
    const state = makeGame({ players: ['a', 'b'] });
    state.icebergHp = 2;
    startWave(state);
    runUntil(state, (s) => s.phase === PHASE.GAME_OVER, { describe: 'defeat' });

    resetToLobby(state);

    assert.equal(state.phase, PHASE.LOBBY);
    assert.equal(state.wave, 0);
    assert.equal(state.players.size, 2);
    assert.deepEqual(state.towers, []);
    assert.equal(state.outcome, null);
  });

  it('restores the numbers the lobby shows before the next game', () => {
    // The lobby reports fish and iceberg HP, and `startGame` is what actually resets
    // them — so without this the lobby sits displaying the state of the run that was
    // just abandoned. A player who restarts after spending reads their reduced fish as
    // a handicap they have to play around.
    const state = makeGame({ players: ['a', 'b'] });
    state.icebergHp = 2;
    for (const player of state.players.values()) player.fish = 7;

    resetToLobby(state);

    assert.equal(state.icebergHp, ICEBERG_HP);
    for (const player of state.players.values()) {
      assert.equal(player.fish, STARTING_FISH, `${player.id} kept spent-down fish`);
    }
  });

  it('shows a full iceberg after a defeat, not the zero it ended on', () => {
    const state = makeGame({ players: ['a'] });
    state.icebergHp = 2;
    startWave(state);
    runUntil(state, (s) => s.phase === PHASE.GAME_OVER, { describe: 'defeat' });
    assert.equal(state.icebergHp, 0);

    resetToLobby(state);

    assert.equal(state.icebergHp, ICEBERG_HP);
  });
});

describe('drainEvents', () => {
  it('returns pending events and empties the queue', () => {
    const state = makeGame();
    startWave(state);

    const first = drainEvents(state);
    assert.ok(first.length > 0);
    assert.deepEqual(drainEvents(state), [], 'a second drain must be empty');
  });
});

describe('snapshot', () => {
  it('reports the fields a client needs to draw the world', () => {
    const state = makeGame({ players: ['a'] });
    startWave(state);
    tick(state, TICK_MS);

    const snap = snapshot(state);

    assert.equal(snap.phase, PHASE.WAVE);
    assert.equal(snap.wave, 1);
    assert.equal(snap.totalWaves, TOTAL_WAVES);
    assert.equal(snap.icebergMaxHp, ICEBERG_HP);
    assert.equal(snap.players.length, 1);
    assert.equal(snap.enemies.length, 1);
  });

  it('reports enemy health as a fraction, not raw hit points', () => {
    // The client draws a bar; raw values would leak the headcount scaling and force
    // the client to know the tuning table.
    const state = makeGame();
    startWave(state);
    tick(state, TICK_MS);
    state.enemies[0].hp = state.enemies[0].maxHp / 2;

    assert.equal(snapshot(state).enemies[0].hp, 0.5);
  });

  it('survives a JSON round trip unchanged', () => {
    const state = makeGame({ players: ['a', 'b'] });
    startWave(state);
    runTicks(state, 20);

    const snap = snapshot(state);
    assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
  });

  it('sends exactly the agreed set of fields and nothing more', () => {
    // Spawn schedules, hit-point scaling, and tower cooldowns are server business;
    // shipping them invites a client to try simulating. Pinning the whole key set
    // means adding a field to the wire format is a deliberate act with a test to update.
    const state = makeGame();
    startWave(state);
    tick(state, TICK_MS);

    assert.deepEqual(Object.keys(snapshot(state)).sort(), [
      'enemies',
      'icebergHp',
      'icebergMaxHp',
      'kills',
      'leaks',
      'outcome',
      'phase',
      'players',
      'projectiles',
      'tick',
      'totalWaves',
      'towers',
      'wave',
      'waveProgress',
    ]);
  });

  it('never exposes tower cooldowns', () => {
    const state = makeGame();
    grantFish(state, 'p1');
    const [tile] = tilesNearPath(1);
    place(state, 'p1', tile.x, tile.y, 'pistol');

    for (const tower of snapshot(state).towers) {
      // `level` and `invested` are on the wire deliberately: every client must show the
      // same penguin the same way, the upgrade button needs an exact next price, and the
      // sell button an exact refund. A client deriving the refund from the base cost now
      // disagrees with the server about every upgraded penguin.
      assert.deepEqual(
        Object.keys(tower).sort(),
        ['id', 'invested', 'level', 'owner', 'type', 'x', 'y'],
      );
    }
  });

  it('rounds coordinates rather than sending full float precision', () => {
    const state = makeGame();
    startWave(state);
    runTicks(state, 7);

    for (const enemy of snapshot(state).enemies) {
      assert.equal(enemy.progress, Math.round(enemy.progress * 100) / 100);
    }
  });

  it('reports wave progress during a wave and nothing outside one', () => {
    const state = makeGame();
    assert.equal(snapshot(state).waveProgress, null, 'no progress in the build phase');

    startWave(state);
    tick(state, TICK_MS);
    const progress = snapshot(state).waveProgress;

    assert.ok(progress !== null, 'a wave in progress must report progress');
    assert.equal(progress.spawned, 1);
    assert.ok(progress.total > 1);
  });

  it('floors fish so the HUD never shows a fraction', () => {
    const state = makeGame();
    player(state, 'p1').fish = 12.7;

    assert.equal(snapshot(state).players[0].fish, 12);
  });
});

describe('a whole game, headlessly', () => {
  it('plays every wave through to a decision with no timers involved', () => {
    // The point of keeping the simulation pure: a full 15-wave game runs inside a unit
    // test in milliseconds, driven entirely by an explicit timestep.
    const state = makeGame({ players: ['a'] });
    grantFish(state, 'a', 100_000);

    for (const tile of tilesNearPath(20)) {
      place(state, 'a', tile.x, tile.y, 'pistol');
    }

    let wavesPlayed = 0;
    while (state.phase !== PHASE.GAME_OVER && wavesPlayed <= TOTAL_WAVES) {
      assert.equal(state.phase, PHASE.BUILD, 'between waves the game must sit in build');
      startWave(state);
      wavesPlayed += 1;
      runUntil(state, (s) => s.phase !== PHASE.WAVE, { describe: `wave ${wavesPlayed} to end` });
    }

    assert.equal(state.phase, PHASE.GAME_OVER);
    assert.ok(
      state.outcome === 'win' || state.outcome === 'loss',
      `unexpected outcome: ${state.outcome}`,
    );
    assert.ok(wavesPlayed >= 1);
  });

  it('never lets the iceberg go negative across a full game', () => {
    const state = makeGame({ players: ['a'] });

    while (state.phase !== PHASE.GAME_OVER) {
      if (state.phase === PHASE.BUILD) startWave(state);
      tick(state, TICK_MS);
      assert.ok(state.icebergHp >= 0, `iceberg went negative: ${state.icebergHp}`);
    }
  });
});
