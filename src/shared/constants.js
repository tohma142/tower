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

/**
 * Iceberg hit points. Each enemy that reaches it subtracts its own `damage`.
 *
 * Small on purpose. A pool of 100 made the first six waves the only ones that mattered
 * and still left 50 points unspent at the end — leaks stopped being decisions. At 25, a
 * single Polar Bear costs 40% of the objective.
 *
 * This number is load-bearing against {@link ENEMY_TYPES} speeds, not independent of
 * them: 25 with the original speeds is unwinnable at every team size (dead on wave 3,
 * four penguins in). The two were retuned together — see the speed note on ENEMY_TYPES.
 */
export const ICEBERG_HP = 25;

// --- Upgrades ----------------------------------------------------------------

/** Levels a penguin can reach. Level 1 is what placing one gives you. */
export const MAX_TOWER_LEVEL = 3;

/**
 * Output multiplier at each level, indexed from level 1.
 *
 * "Output" is damage for a penguin that shoots and income for one that does not, so a
 * single table covers both and no unit can be upgraded into something the table never
 * anticipated.
 *
 * Superlinear on purpose. Upgrading has to compete with buying another penguin, and a
 * second penguin brings its own tile, its own coverage, and its own target. Matching the
 * price with a matching output increase would make upgrading strictly worse than
 * expanding, and the feature would be decoration.
 */
export const TOWER_LEVEL_MULTIPLIER = Object.freeze([1, 1.75, 3]);

/**
 * Fish to take a penguin from `level` to the next one.
 *
 * Priced off the unit's own cost so a Sniper upgrade stays expensive relative to a
 * Pistol upgrade without a second table to keep in step.
 *
 * @param {TowerType} spec
 * @param {number} level Current level, 1-based.
 * @returns {number} Cost, or Infinity when already at the cap — so an unguarded caller
 *   fails to afford it rather than silently upgrading past the table.
 */
export function upgradeCostFor(spec, level) {
  if (level >= MAX_TOWER_LEVEL) return Infinity;
  return Math.round(spec.cost * 0.8 * level);
}

/**
 * A penguin's output multiplier at a given level.
 *
 * @param {number} level 1-based.
 * @returns {number}
 */
export function levelMultiplier(level) {
  return TOWER_LEVEL_MULTIPLIER[level - 1] ?? 1;
}

// --- Selling -----------------------------------------------------------------

/**
 * Fraction of what a penguin cost that selling it returns.
 *
 * Not 1.0 on purpose. A full refund would make placement free to undo, and placement is
 * the deepest decision in this game — the difference between coverage-ranked tiles and
 * a left-to-right scan decides whole runs. At 0.7 a misclick costs 30% rather than the
 * whole penguin, which is enough to keep the decision real without making it punishing.
 *
 * Applied to everything sunk into the penguin, not just its purchase price, so this
 * stays correct when upgrades start adding to that total.
 */
export const SELL_REFUND_RATE = 0.7;

/**
 * What selling a penguin pays back.
 *
 * Shared rather than duplicated, because both sides compute it: the server to move the
 * fish, the client to put a number on the button *before* the click. Two independent
 * roundings would eventually disagree, and a button that promises 36 and pays 35 reads
 * as a bug in the game rather than in the arithmetic.
 *
 * Floored, so a sell-and-rebuy cycle can never manufacture fish out of rounding.
 *
 * The product is snapped to whole fish before flooring, because binary floating point
 * puts `90 * 0.7` at 62.99999999999999 and a bare floor pays 62 for a penguin worth 63.
 * Upgrades are what made that reachable: no base tower cost lands on an affected total,
 * but a cost plus an upgrade does, and 90 is a Pistol upgraded once. The snap only ever
 * absorbs error of order 1e-13, so it cannot round a genuine 62.9 up to 63.
 *
 * @param {number} invested Total fish sunk into the penguin.
 * @returns {number} Fish returned, never negative.
 */
export function sellRefundFor(invested) {
  const exact = Math.round(invested * SELL_REFUND_RATE * 1e6) / 1e6;
  return Math.max(0, Math.floor(exact));
}

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
 * structural advantage. Measured across 1–4 players, this leaves the iceberg at 5–11
 * of 25 at the end of wave 15 regardless of team size; the earlier 1 + 0.6(n-1) left
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
 * @property {number} income      Fish paid to every player each time a wave is cleared.
 *                                Zero for everything that shoots.
 */

/**
 * Whether a penguin is one that shoots.
 *
 * The distinction is `damage`, not a category flag, because damage is the thing every
 * caller actually cares about — a flag could disagree with the stats beside it.
 *
 * @param {TowerType} spec
 * @returns {boolean}
 */
export function isCombatTower(spec) {
  return spec.damage > 0;
}

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
    income: 0,
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
    income: 0,
  }),
  /**
   * Splash is 1.75 tiles, not 1. At 1 the Bomber was barely playable: a bomber-led build
   * lost on wave 3 at every team size, and each blast caught 1.88 enemies — barely more
   * than a single-target round, for three times the price of a Pistol.
   *
   * 1.75 is the measured threshold, not a round number. Under the reference build's
   * placement, 1.5 still loses on wave 3; 1.75 clears all fifteen waves finishing on 5 of
   * 25 solo and 1 of 25 at four players, which is as tight as the sniper build. Above it
   * the unit stops being a trade: 2.0 finishes on 11, and 2.5 on 17, which is the same
   * "nothing is at stake" the iceberg was dropped to 25 to fix.
   *
   * That threshold moves with placement, which is worth knowing before retuning it. A
   * harness ranking tiles by the Bomber's own range of 4 rather than the reference range
   * of 3 found 1.5 sufficient. The number here is the conservative one.
   *
   * Splash does full damage to everything in the radius with no falloff, so this is a
   * straight power increase and the radius is the only dial. Note the path doubles back
   * on itself, and at this radius a blast on a corner can catch enemies on the other
   * leg — intended, and part of why placement matters.
   */
  bomber: Object.freeze({
    id: 'bomber',
    name: 'Bomber',
    cost: 150,
    range: 4,
    damage: 6,
    fireRate: 0.7,
    splashRadius: 1.75,
    projectileSpeed: 8,
    income: 0,
  }),
  /**
   * The Fisher does not shoot. It catches fish, paying every player at the end of each
   * wave — the economy equivalent of a tower, and the first thing in this game that
   * money can be spent on other than more guns.
   *
   * Its real cost is not the 100 fish, it is the *tile*. High-coverage tiles are scarce,
   * and putting a Fisher on one trades defence now for money later. That is the decision
   * the unit exists to create; a Fisher tucked in a useless corner should be close to
   * free, and it is.
   *
   * Priced to repay itself in five waves at 20 a wave, so buying one is clearly right
   * early and clearly wrong on wave 14.
   */
  fisher: Object.freeze({
    id: 'fisher',
    name: 'Fisher',
    cost: 100,
    range: 0,
    damage: 0,
    fireRate: 0,
    splashRadius: 0,
    projectileSpeed: 0,
    income: 20,
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
 * Speeds are ~0.7× the original 1.8 / 3.6 / 1.1, and that factor pairs with
 * {@link ICEBERG_HP} dropping from 100 to 25. Speed is really a *damage* knob here:
 * slower enemies spend longer inside tower range, so each penguin lands more shots per
 * creature and fewer things reach the objective. Measured at 25 iceberg HP, 1.0× loses
 * at every team size on wave 3 and 0.8× still loses solo; 0.7× is the fastest the
 * enemies can move and leave the game winnable, and it leaves solo finishing on 5 of 25.
 * Below ~0.4× nobody takes a scratch and the objective stops existing.
 *
 * @type {Readonly<Record<string, EnemyType>>}
 */
export const ENEMY_TYPES = Object.freeze({
  walker: Object.freeze({ id: 'walker', name: 'Walrus', hp: 50, speed: 1.25, damage: 2, bounty: 5 }),
  runner: Object.freeze({ id: 'runner', name: 'Arctic Fox', hp: 25, speed: 2.5, damage: 1, bounty: 4 }),
  brute: Object.freeze({ id: 'brute', name: 'Polar Bear', hp: 225, speed: 0.75, damage: 10, bounty: 15 }),
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
