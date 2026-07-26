/**
 * Game constants and tuning tables.
 *
 * Runs unmodified in both Node and the browser, so nothing here may touch `process`,
 * `window`, or `document` — ESLint enforces that by giving this directory neither set
 * of globals.
 *
 * Balance lives in data, not code. Tuning the game means editing the tables at the
 * bottom of this file; it should never mean editing a simulation module.
 *
 * Units, stated once so the tables stay readable:
 *   - distance   tiles
 *   - speed      tiles per second
 *   - fireRate   shots per second
 *   - durations  milliseconds
 */

// --- Simulation cadence ------------------------------------------------------

/** Authoritative simulation rate. The server ticks at this fixed timestep. */
export const TICK_HZ = 20;

/** Milliseconds per simulation tick. */
export const TICK_MS = 1000 / TICK_HZ;

/**
 * How far behind the newest snapshot the client renders.
 *
 * The client draws the world interpolated between the two snapshots straddling
 * `now - RENDER_DELAY_MS`. Without this the 20 Hz simulation visibly stutters; with it
 * the cost is a fixed, imperceptible input latency. Must exceed TICK_MS with margin,
 * or a single late packet leaves nothing to interpolate towards.
 */
export const RENDER_DELAY_MS = 100;

// --- Board -------------------------------------------------------------------

/** Board width in tiles. */
export const GRID_COLS = 20;

/** Board height in tiles. */
export const GRID_ROWS = 12;

/** Native pixels per tile, before the integer render scale is applied. */
export const TILE_PX = 16;

/**
 * Integer upscale factor for rendering. Kept an integer, and paired with
 * `imageSmoothingEnabled = false`, so pixel art stays crisp instead of blurring.
 */
export const RENDER_SCALE = 3;

// --- Room and session --------------------------------------------------------

/** Hard cap on players in one room. Every system iterates a player list, so raising
 *  this is a one-constant change plus a balance pass. */
export const MAX_PLAYERS = 4;

/** Spectators allowed to watch a room in progress. */
export const MAX_SPECTATORS = 8;

/** How long a disconnected player's seat is held for a reconnect before it is freed
 *  and their unspent fish forfeited. */
export const RECONNECT_GRACE_MS = 60_000;

/** How long a room with zero connections survives before it is destroyed. */
export const ROOM_EMPTY_GC_MS = 60_000;

/** Characters used to build room codes. Excludes vowels (so codes cannot spell
 *  anything unfortunate) and the 0/O and 1/I lookalikes. */
export const ROOM_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXYZ23456789';

/** Length of a generated room code. */
export const ROOM_CODE_LENGTH = 5;

// --- Economy and objective ---------------------------------------------------

/** Fish each player starts a game with. */
export const STARTING_FISH = 150;

/** Iceberg hit points. Each enemy that reaches it subtracts its own `damage`. */
export const ICEBERG_HP = 100;

/** Waves in a full game. */
export const TOTAL_WAVES = 15;

/**
 * Enemy hit-point multiplier for a given headcount.
 *
 * Exactly linear: each player adds one enemy's worth of toughness. That is not a round
 * number chosen for tidiness — it is what makes headcount fair.
 *
 * Income is shared, and wallets are per-player, so a team's total purchasing power
 * scales linearly with headcount. Anything shallower than linear hands larger teams a
 * structural advantage. Measured across 1–4 players, this leaves the iceberg at 50–62
 * of 100 at the end of wave 15 regardless of team size; the earlier 1 + 0.6(n-1) left
 * bigger teams visibly better off.
 *
 * Locked in when the game starts, so mid-game joins and drops cannot retune a wave
 * that is already running.
 *
 * @param {number} playerCount Players seated when the game began.
 * @returns {number} Multiplier applied to every enemy's base hit points.
 */
export function hpScaleFor(playerCount) {
  return Math.max(1, playerCount);
}

/**
 * Fish paid to every player when a wave is cleared, as `BASE + PER_WAVE * wave`.
 *
 * This exists to break a death spiral. With income coming only from kills, a team that
 * opens badly cannot afford more penguins, so it kills less, so it earns less — and by
 * wave 6 it is over with nothing to be done about it. A guaranteed payment for
 * surviving decouples recovery from kill throughput.
 *
 * The effect is measurable rather than theoretical: at the difficulty this game is now
 * tuned to, a solo run with no wave bonus collapses on wave 7, and the same run with
 * this bonus finishes all 15 waves.
 */
export const WAVE_CLEAR_BONUS_BASE = 40;

/** Extra fish per wave number, so later waves fund the harder waves that follow. */
export const WAVE_CLEAR_BONUS_PER_WAVE = 5;

/**
 * Fish paid to each player for clearing a wave.
 *
 * @param {number} wave One-based wave number just cleared.
 * @returns {number}
 */
export function waveClearBonus(wave) {
  return WAVE_CLEAR_BONUS_BASE + WAVE_CLEAR_BONUS_PER_WAVE * wave;
}

// --- Phases ------------------------------------------------------------------

/**
 * Room phases.
 *
 * LOBBY -> BUILD -> WAVE -> BUILD -> ... -> WAVE(15) -> GAME_OVER -> LOBBY
 *
 * Joining during LOBBY takes a seat; joining at any other time makes you a spectator.
 * @readonly
 */
export const PHASE = Object.freeze({
  LOBBY: 'lobby',
  BUILD: 'build',
  WAVE: 'wave',
  GAME_OVER: 'gameOver',
});

/** @typedef {typeof PHASE[keyof typeof PHASE]} Phase */

// --- Penguins ----------------------------------------------------------------

/**
 * @typedef {object} TowerType
 * @property {string} id
 * @property {string} name
 * @property {number} cost         Fish to place one.
 * @property {number} range        Firing radius in tiles.
 * @property {number} damage       Damage per projectile hit.
 * @property {number} fireRate     Shots per second.
 * @property {number} splashRadius Tiles; 0 means single-target.
 * @property {number} projectileSpeed Tiles per second.
 */

/** @type {Readonly<Record<string, TowerType>>} */
export const TOWER_TYPES = Object.freeze({
  pistol: Object.freeze({
    id: 'pistol',
    name: 'Pistol',
    cost: 50,
    range: 3,
    damage: 2,
    fireRate: 3,
    splashRadius: 0,
    projectileSpeed: 14,
  }),
  sniper: Object.freeze({
    id: 'sniper',
    name: 'Sniper',
    cost: 120,
    range: 7,
    damage: 12,
    fireRate: 0.5,
    splashRadius: 0,
    projectileSpeed: 30,
  }),
  bomber: Object.freeze({
    id: 'bomber',
    name: 'Bomber',
    cost: 150,
    range: 4,
    damage: 6,
    fireRate: 0.7,
    splashRadius: 1,
    projectileSpeed: 8,
  }),
});

/** @type {ReadonlyArray<string>} */
export const TOWER_TYPE_IDS = Object.freeze(Object.keys(TOWER_TYPES));

// --- Enemies -----------------------------------------------------------------

/**
 * @typedef {object} EnemyType
 * @property {string} id
 * @property {string} name
 * @property {number} hp     Base hit points, before the headcount multiplier.
 * @property {number} speed  Tiles per second along the path.
 * @property {number} damage Iceberg damage dealt if it survives the whole path.
 * @property {number} bounty Fish paid to every player when killed.
 */

/**
 * Hit points here are 2.5× what a first pass would suggest, and that factor is the
 * single knob that sets how hard the game is.
 *
 * Measured, not guessed: at the original values a competent player finished all 15
 * waves without losing a single point of iceberg at any team size — no tension at all.
 * At 2.5× the same player finishes with roughly half the iceberg gone. Push it to 3×
 * and every team size dies on wave 7, because the economy compounds and a bad opening
 * is unrecoverable.
 *
 * @type {Readonly<Record<string, EnemyType>>}
 */
export const ENEMY_TYPES = Object.freeze({
  walker: Object.freeze({ id: 'walker', name: 'Walrus', hp: 50, speed: 1.8, damage: 2, bounty: 5 }),
  runner: Object.freeze({ id: 'runner', name: 'Arctic Fox', hp: 25, speed: 3.6, damage: 1, bounty: 4 }),
  brute: Object.freeze({ id: 'brute', name: 'Polar Bear', hp: 225, speed: 1.1, damage: 10, bounty: 15 }),
});

/** @type {ReadonlyArray<string>} */
export const ENEMY_TYPE_IDS = Object.freeze(Object.keys(ENEMY_TYPES));

// --- Waves -------------------------------------------------------------------

/**
 * A contiguous run of one enemy type within a wave.
 *
 * @typedef {object} SpawnGroup
 * @property {string} type      Key into ENEMY_TYPES.
 * @property {number} count     How many to spawn.
 * @property {number} spacingMs Gap between consecutive spawns in this group.
 * @property {number} delayMs   Offset from the start of the wave before the first spawn.
 *                              Groups overlap freely, which is how mixed waves are built.
 */

/**
 * The 15 waves, in order. Index 0 is wave 1.
 *
 * These are a starting ramp, not final balance — the tuning pass runs a real game at
 * one and four players and edits this table. The balance guard test only asserts the
 * outer bounds (wave 1 survivable, wave 15 not, for a fixed reference build).
 *
 * @type {ReadonlyArray<ReadonlyArray<SpawnGroup>>}
 */
export const WAVES = Object.freeze([
  // 1 — teach the loop: a thin line of walkers.
  Object.freeze([{ type: 'walker', count: 6, spacingMs: 900, delayMs: 0 }]),
  // 2
  Object.freeze([{ type: 'walker', count: 10, spacingMs: 800, delayMs: 0 }]),
  // 3 — introduce runners.
  Object.freeze([
    { type: 'walker', count: 8, spacingMs: 700, delayMs: 0 },
    { type: 'runner', count: 4, spacingMs: 600, delayMs: 4000 },
  ]),
  // 4 — a runner rush; punishes long-cooldown-only builds.
  Object.freeze([{ type: 'runner', count: 12, spacingMs: 450, delayMs: 0 }]),
  // 5 — first brute.
  Object.freeze([
    { type: 'walker', count: 12, spacingMs: 600, delayMs: 0 },
    { type: 'brute', count: 1, spacingMs: 0, delayMs: 3000 },
  ]),
  // 6
  Object.freeze([
    { type: 'walker', count: 14, spacingMs: 500, delayMs: 0 },
    { type: 'runner', count: 8, spacingMs: 400, delayMs: 5000 },
  ]),
  // 7
  Object.freeze([
    { type: 'brute', count: 3, spacingMs: 2000, delayMs: 0 },
    { type: 'walker', count: 10, spacingMs: 500, delayMs: 1000 },
  ]),
  // 8 — pure speed.
  Object.freeze([{ type: 'runner', count: 20, spacingMs: 300, delayMs: 0 }]),
  // 9
  Object.freeze([
    { type: 'walker', count: 16, spacingMs: 400, delayMs: 0 },
    { type: 'brute', count: 4, spacingMs: 1800, delayMs: 4000 },
  ]),
  // 10
  Object.freeze([
    { type: 'brute', count: 6, spacingMs: 1500, delayMs: 0 },
    { type: 'runner', count: 12, spacingMs: 350, delayMs: 3000 },
  ]),
  // 11
  Object.freeze([
    { type: 'walker', count: 24, spacingMs: 300, delayMs: 0 },
    { type: 'runner', count: 10, spacingMs: 300, delayMs: 6000 },
  ]),
  // 12
  Object.freeze([
    { type: 'brute', count: 8, spacingMs: 1200, delayMs: 0 },
    { type: 'walker', count: 14, spacingMs: 400, delayMs: 2000 },
  ]),
  // 13
  Object.freeze([
    { type: 'runner', count: 30, spacingMs: 250, delayMs: 0 },
    { type: 'brute', count: 5, spacingMs: 1500, delayMs: 5000 },
  ]),
  // 14
  Object.freeze([
    { type: 'walker', count: 30, spacingMs: 280, delayMs: 0 },
    { type: 'brute', count: 8, spacingMs: 1000, delayMs: 4000 },
  ]),
  // 15 — everything at once.
  Object.freeze([
    { type: 'brute', count: 15, spacingMs: 900, delayMs: 0 },
    { type: 'runner', count: 20, spacingMs: 250, delayMs: 5000 },
    { type: 'walker', count: 20, spacingMs: 300, delayMs: 10000 },
  ]),
]);
