/**
 * The game state and the tick that advances it.
 *
 * This module is pure in the sense that matters: it performs no I/O, reads no clock, and
 * touches no global. Time arrives as a `dtMs` argument, so a caller can run a full
 * 15-wave game in a loop with no timers involved — which is exactly what the tests do.
 *
 * The state object *is* mutated in place. That is a deliberate exception to the
 * immutable-by-default preference: a 20 Hz loop over hundreds of entities reallocating
 * the world each tick would trade real performance for a purity that buys nothing here,
 * since exactly one owner (the room) ever holds a state.
 */

import {
  ICEBERG_HP,
  PHASE,
  STARTING_FISH,
  TOTAL_WAVES,
  hpScaleFor,
  waveClearBonus,
} from '../shared/constants.js';

import { payBountyToAll } from './economy.js';
import { advanceEnemies, removeDeadEnemies, spawnEnemy } from './enemies.js';
import { advanceProjectiles } from './projectiles.js';
import { updateTowers } from './towers.js';
import { buildSpawnSchedule, waveEnemyCount } from './waves.js';

/**
 * @typedef {object} Player
 * @property {string} id
 * @property {string} name
 * @property {number} fish
 * @property {boolean} ready
 * @property {boolean} connected Disconnected players keep their towers and fish for the
 *   grace period but are excluded from the ready gate, or the game deadlocks.
 */

/**
 * @typedef {object} GameEvent
 * @property {string} kind
 * @property {any} [enemyType]
 * @property {any} [damage]
 * @property {any} [icebergHp]
 * @property {any} [wave]
 * @property {any} [outcome]
 * @property {any} [bonus] Fish paid to each player for clearing a wave.
 */

/**
 * @typedef {object} GameState
 * @property {string} phase
 * @property {number} wave            Current wave, 1-based. 0 before the first wave.
 * @property {number} waveElapsedMs   Time since the current wave began.
 * @property {import('./waves.js').ScheduledSpawn[]} schedule
 * @property {number} spawnIndex      How far through `schedule` spawning has got.
 * @property {number} icebergHp
 * @property {number} icebergMaxHp
 * @property {number} hpScale         Fixed when the game starts; see startGame.
 * @property {Map<string, Player>} players
 * @property {import('./enemies.js').Enemy[]} enemies
 * @property {import('./towers.js').Tower[]} towers
 * @property {import('./projectiles.js').Projectile[]} projectiles
 * @property {Map<string, number>} occupancy Tile key to tower id.
 * @property {number} nextId
 * @property {number} tickCount
 * @property {number} kills
 * @property {number} leaks
 * @property {string | null} outcome  'win' | 'loss' once the game is over.
 * @property {GameEvent[]} events     Drained by the room each tick and broadcast.
 */

/**
 * Create an empty game in the lobby.
 *
 * @returns {GameState}
 */
export function createGameState() {
  return {
    phase: PHASE.LOBBY,
    wave: 0,
    waveElapsedMs: 0,
    schedule: [],
    spawnIndex: 0,
    icebergHp: ICEBERG_HP,
    icebergMaxHp: ICEBERG_HP,
    hpScale: 1,
    players: new Map(),
    enemies: [],
    towers: [],
    projectiles: [],
    occupancy: new Map(),
    nextId: 1,
    tickCount: 0,
    kills: 0,
    leaks: 0,
    outcome: null,
    events: [],
  };
}

/**
 * Seat a player.
 *
 * @param {GameState} state
 * @param {string} id
 * @param {string} name
 * @returns {Player}
 */
export function addPlayer(state, id, name) {
  const existing = state.players.get(id);
  if (existing !== undefined) {
    existing.connected = true;
    return existing;
  }

  /** @type {Player} */
  const player = { id, name, fish: STARTING_FISH, ready: false, connected: true };
  state.players.set(id, player);
  return player;
}

/**
 * Remove a player entirely, once their reconnect grace period has expired.
 *
 * Their towers stay on the board: they were bought with shared effort and removing them
 * mid-wave would punish the players who are still here for someone else's dropout.
 *
 * @param {GameState} state
 * @param {string} id
 * @returns {void}
 */
export function removePlayer(state, id) {
  state.players.delete(id);
}

/**
 * Mark a player connected or not. A disconnected player is immediately excluded from
 * the ready gate — without this, one dropped connection stalls the game forever.
 *
 * @param {GameState} state
 * @param {string} id
 * @param {boolean} connected
 * @returns {void}
 */
export function setConnected(state, id, connected) {
  const player = state.players.get(id);
  if (player === undefined) return;

  player.connected = connected;
  if (!connected) player.ready = false;
}

/**
 * Whether the ready gate is satisfied.
 *
 * Requires at least one connected player, so an empty room cannot start a wave, and
 * every connected player to be ready. Disconnected players do not count either way.
 *
 * @param {GameState} state
 * @returns {boolean}
 */
export function allPlayersReady(state) {
  let connectedCount = 0;

  for (const player of state.players.values()) {
    if (!player.connected) continue;
    connectedCount += 1;
    if (!player.ready) return false;
  }

  return connectedCount > 0;
}

/**
 * Names of connected players who have not readied, for the HUD.
 *
 * The all-players-ready gate has no timeout, so an idle player can stall everyone. The
 * mitigation is making it obvious who the game is waiting on.
 *
 * @param {GameState} state
 * @returns {string[]}
 */
export function playersNotReady(state) {
  const waiting = [];
  for (const player of state.players.values()) {
    if (player.connected && !player.ready) waiting.push(player.name);
  }
  return waiting;
}

/**
 * Begin a new game from the lobby.
 *
 * Fixes the hit-point multiplier from the headcount *now* and leaves it fixed for the
 * whole game. Recomputing it as players join and leave would retune waves already in
 * flight, and would let a team make wave 15 easier by having someone disconnect.
 *
 * @param {GameState} state
 * @returns {void}
 */
export function startGame(state) {
  const seated = [...state.players.values()].filter((p) => p.connected).length;

  state.hpScale = hpScaleFor(seated);
  state.phase = PHASE.BUILD;
  state.wave = 0;
  state.waveElapsedMs = 0;
  state.schedule = [];
  state.spawnIndex = 0;
  state.icebergHp = ICEBERG_HP;
  state.enemies = [];
  state.towers = [];
  state.projectiles = [];
  state.occupancy = new Map();
  state.kills = 0;
  state.leaks = 0;
  state.outcome = null;

  for (const player of state.players.values()) {
    player.fish = STARTING_FISH;
    player.ready = false;
  }

  state.events.push({ kind: 'gameStarted', wave: 0 });
}

/**
 * Start the next wave. The room calls this once the ready gate is satisfied.
 *
 * @param {GameState} state
 * @returns {void}
 * @throws {Error} If called outside the build phase, which would mean the room's phase
 *   machine and the simulation have drifted apart.
 */
export function startWave(state) {
  if (state.phase !== PHASE.BUILD) {
    throw new Error(`cannot start a wave from phase: ${state.phase}`);
  }

  state.wave += 1;
  state.waveElapsedMs = 0;
  state.schedule = buildSpawnSchedule(state.wave);
  state.spawnIndex = 0;
  state.phase = PHASE.WAVE;

  for (const player of state.players.values()) {
    player.ready = false;
  }

  state.events.push({ kind: 'waveStarted', wave: state.wave });
}

/**
 * Return a finished game to the lobby, keeping the seated players.
 *
 * @param {GameState} state
 * @returns {void}
 */
export function resetToLobby(state) {
  state.phase = PHASE.LOBBY;
  state.wave = 0;
  state.enemies = [];
  state.towers = [];
  state.projectiles = [];
  state.occupancy = new Map();
  state.outcome = null;

  for (const player of state.players.values()) {
    player.ready = false;
  }

  state.events.push({ kind: 'returnedToLobby' });
}

/**
 * End the game.
 *
 * @param {GameState} state
 * @param {'win' | 'loss'} outcome
 * @returns {void}
 */
function endGame(state, outcome) {
  state.phase = PHASE.GAME_OVER;
  state.outcome = outcome;
  state.enemies = [];
  state.projectiles = [];
  state.events.push({ kind: 'gameOver', outcome, wave: state.wave });
}

/**
 * Advance the simulation by one step.
 *
 * Order within a tick is deliberate: enemies move, then towers acquire and fire, then
 * projectiles resolve, then the dead are swept. Sweeping last means every system sees a
 * consistent enemy list, and splash damage cannot skip an enemy because the array
 * shifted underneath it mid-iteration.
 *
 * @param {GameState} state
 * @param {number} dtMs Milliseconds to advance. Callers pass a fixed timestep.
 * @returns {void}
 */
export function tick(state, dtMs) {
  state.tickCount += 1;

  if (state.phase !== PHASE.WAVE) return;

  state.waveElapsedMs += dtMs;

  while (
    state.spawnIndex < state.schedule.length &&
    state.schedule[state.spawnIndex].atMs <= state.waveElapsedMs
  ) {
    spawnEnemy(state, state.schedule[state.spawnIndex].type);
    state.spawnIndex += 1;
  }

  advanceEnemies(state, dtMs);
  updateTowers(state, dtMs);
  advanceProjectiles(state, dtMs);
  removeDeadEnemies(state);

  if (state.icebergHp <= 0) {
    endGame(state, 'loss');
    return;
  }

  const spawningDone = state.spawnIndex >= state.schedule.length;
  if (spawningDone && state.enemies.length === 0) {
    if (state.wave >= TOTAL_WAVES) {
      endGame(state, 'win');
      return;
    }

    // Drop any rounds still in the air. Without this they would hang mid-flight for the
    // whole build phase, since the tick returns early outside a wave.
    state.projectiles = [];
    state.phase = PHASE.BUILD;

    // Pay for surviving, not just for killing. Income from kills alone compounds in
    // both directions: a team that opens badly cannot afford more penguins, so it kills
    // less, so it earns less, and by wave 6 the game is decided. This payment decouples
    // recovery from kill throughput.
    const bonus = waveClearBonus(state.wave);
    payBountyToAll(state, bonus);

    state.events.push({ kind: 'waveCleared', wave: state.wave, bonus });
  }
}

/**
 * Take everything pending and clear the queue.
 *
 * @param {GameState} state
 * @returns {GameEvent[]}
 */
export function drainEvents(state) {
  if (state.events.length === 0) return [];
  const events = state.events;
  state.events = [];
  return events;
}

/**
 * Round to two decimals. Snapshots go out 20 times a second; full float precision on
 * every coordinate is bytes spent on detail no one can see at three pixels per tile.
 *
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * The world as a client sees it.
 *
 * @typedef {object} SnapshotPlayer
 * @property {string} id
 * @property {string} name
 * @property {number} fish
 * @property {boolean} ready
 * @property {boolean} connected
 */

/**
 * @typedef {object} SnapshotEnemy
 * @property {number} id
 * @property {string} type
 * @property {number} progress Tiles along the path; the client derives x/y from it.
 * @property {number} hp       Fraction of maximum, 0..1.
 */

/**
 * @typedef {object} SnapshotTower
 * @property {number} id
 * @property {string} type
 * @property {number} x Tile column.
 * @property {number} y Tile row.
 * @property {string} owner
 */

/**
 * @typedef {object} SnapshotProjectile
 * @property {number} id
 * @property {number} x
 * @property {number} y
 * @property {boolean} splash
 */

/**
 * @typedef {object} Snapshot
 * @property {number} tick
 * @property {string} phase
 * @property {number} wave
 * @property {number} totalWaves
 * @property {number} icebergHp
 * @property {number} icebergMaxHp
 * @property {string | null} outcome
 * @property {number} kills
 * @property {number} leaks
 * @property {{ spawned: number, total: number } | null} waveProgress
 * @property {SnapshotPlayer[]} players
 * @property {SnapshotEnemy[]} enemies
 * @property {SnapshotTower[]} towers
 * @property {SnapshotProjectile[]} projectiles
 */

/**
 * Build the wire representation of the world.
 *
 * Contains only what a client must draw or display. Notably absent: tower cooldowns,
 * spawn schedules, and projectile targets — all server business, and sending them would
 * invite a client to try simulating.
 *
 * @param {GameState} state
 * @returns {Snapshot}
 */
export function snapshot(state) {
  return {
    tick: state.tickCount,
    phase: state.phase,
    wave: state.wave,
    totalWaves: TOTAL_WAVES,
    icebergHp: round2(state.icebergHp),
    icebergMaxHp: state.icebergMaxHp,
    outcome: state.outcome,
    kills: state.kills,
    leaks: state.leaks,
    waveProgress:
      state.phase === PHASE.WAVE && state.wave > 0
        ? { spawned: state.spawnIndex, total: waveEnemyCount(state.wave) }
        : null,
    players: [...state.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      fish: Math.floor(p.fish),
      ready: p.ready,
      connected: p.connected,
    })),
    enemies: state.enemies.map((e) => ({
      id: e.id,
      type: e.type,
      progress: round2(e.progress),
      hp: round2(e.hp / e.maxHp),
    })),
    towers: state.towers.map((t) => ({
      id: t.id,
      type: t.type,
      x: t.tileX,
      y: t.tileY,
      owner: t.ownerId,
    })),
    projectiles: state.projectiles.map((p) => ({
      id: p.id,
      x: round2(p.x),
      y: round2(p.y),
      splash: p.splashRadius > 0,
    })),
  };
}
