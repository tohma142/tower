/**
 * Enemies: spawning, walking the path, dying, and reaching the iceberg.
 *
 * Enemies have no steering and no collision. Each one is a scalar position along the
 * path — `progress`, measured in tiles from spawn — and its world coordinates are
 * derived from that. This is what keeps the simulation cheap enough to run a whole
 * 15-wave game inside a unit test, and it makes "which enemy is furthest along?"
 * (the targeting question) a plain numeric comparison.
 */

import { DEFAULT_TARGET_PRIORITY, ENEMY_TYPES, TARGET_PRIORITY } from '../shared/constants.js';
import { PATH_LENGTH, positionAt } from '../shared/map.js';

import { payBountyToAll } from './economy.js';

/**
 * @typedef {object} Enemy
 * @property {number} id
 * @property {string} type     Key into ENEMY_TYPES.
 * @property {number} hp       Current hit points.
 * @property {number} maxHp    Hit points at spawn, after headcount scaling.
 * @property {number} progress Tiles travelled along the path.
 * @property {number} speed    Tiles per second.
 */

/**
 * Add an enemy at the start of the path.
 *
 * @param {import('./state.js').GameState} state
 * @param {string} type Key into ENEMY_TYPES.
 * @returns {Enemy} The spawned enemy, already appended to the state.
 * @throws {TypeError} If the type is not in the tuning table — a typo in the wave table
 *   should fail loudly here rather than produce an enemy with NaN hit points.
 */
export function spawnEnemy(state, type) {
  const spec = ENEMY_TYPES[type];
  if (spec === undefined) {
    throw new TypeError(`unknown enemy type: ${type}`);
  }

  // Hit points are scaled once, at spawn, from the multiplier fixed when the game began.
  // Scaling at damage time instead would let a mid-game join retune enemies already
  // walking the board.
  const maxHp = spec.hp * state.hpScale;

  /** @type {Enemy} */
  const enemy = {
    id: state.nextId,
    type,
    hp: maxHp,
    maxHp,
    progress: 0,
    speed: spec.speed,
  };
  state.nextId += 1;

  state.enemies.push(enemy);
  return enemy;
}

/**
 * World position of an enemy.
 *
 * @param {Enemy} enemy
 * @returns {{ x: number, y: number }}
 */
export function enemyPosition(enemy) {
  return positionAt(enemy.progress);
}

/**
 * Apply damage, paying out and removing the enemy if it dies.
 *
 * Removal is deferred to a `dead` flag swept at the end of the tick rather than a
 * splice here: splash damage iterates the enemy list, and mutating it mid-iteration is
 * how enemies get silently skipped.
 *
 * @param {import('./state.js').GameState} state
 * @param {Enemy} enemy
 * @param {number} amount
 * @returns {boolean} True if this damage killed the enemy.
 */
export function damageEnemy(state, enemy, amount) {
  if (enemy.hp <= 0) return false;

  enemy.hp -= amount;
  if (enemy.hp > 0) return false;

  enemy.hp = 0;
  payBountyToAll(state, ENEMY_TYPES[enemy.type].bounty);
  state.kills += 1;
  return true;
}

/**
 * Advance every enemy along the path and resolve any that reach the iceberg.
 *
 * An enemy that arrives deals damage equal to its own strength, so a leaked brute costs
 * far more than a leaked runner — which is the whole point of an iceberg health pool
 * rather than a flat lives counter.
 *
 * @param {import('./state.js').GameState} state
 * @param {number} dtMs Milliseconds elapsed this tick.
 * @returns {void}
 */
export function advanceEnemies(state, dtMs) {
  const dtSeconds = dtMs / 1000;

  for (const enemy of state.enemies) {
    if (enemy.hp <= 0) continue;

    enemy.progress += enemy.speed * dtSeconds;

    if (enemy.progress >= PATH_LENGTH) {
      const damage = ENEMY_TYPES[enemy.type].damage;
      state.icebergHp = Math.max(0, state.icebergHp - damage);
      state.leaks += 1;

      // Zero the hit points so the end-of-tick sweep removes it, and so nothing pays a
      // bounty for an enemy that was never killed.
      enemy.hp = 0;

      state.events.push({ kind: 'leak', enemyType: enemy.type, damage, icebergHp: state.icebergHp });
    }
  }
}

/**
 * Drop dead and leaked enemies from the state.
 *
 * Run once at the end of a tick, after every system that iterates the enemy list.
 *
 * @param {import('./state.js').GameState} state
 * @returns {void}
 */
export function removeDeadEnemies(state) {
  // Filter rather than splice-in-place: a single pass, and no index bookkeeping to get
  // wrong when several enemies die in the same tick.
  if (state.enemies.some((e) => e.hp <= 0)) {
    state.enemies = state.enemies.filter((e) => e.hp > 0);
  }
}

/**
 * How each priority scores a candidate. Highest score wins.
 *
 * Expressed as scores rather than comparators so the selection loop stays a single pass
 * with one shape, and so a new priority is one line here rather than a new branch in the
 * hot path. `distanceSquared` is already computed for the range check, so `closest`
 * costs nothing extra.
 *
 * @type {Readonly<Record<string, (enemy: Enemy, distanceSquared: number) => number>>}
 */
const PRIORITY_SCORE = Object.freeze({
  [TARGET_PRIORITY.FIRST]: (enemy) => enemy.progress,
  [TARGET_PRIORITY.LAST]: (enemy) => -enemy.progress,
  [TARGET_PRIORITY.STRONGEST]: (enemy) => enemy.hp,
  [TARGET_PRIORITY.CLOSEST]: (_enemy, distanceSquared) => -distanceSquared,
});

/**
 * Find the enemy a penguin should shoot, among those within range of a point.
 *
 * Ties are broken by whichever candidate the enemy list reaches first, and that list is
 * in spawn order — so the choice is deterministic without needing a tiebreak rule, which
 * matters because every client must be able to agree on the result.
 *
 * @param {ReadonlyArray<Enemy>} enemies
 * @param {{ x: number, y: number }} origin
 * @param {number} rangeSquared Squared range, to avoid a square root per candidate.
 * @param {string} [priority] One of TARGET_PRIORITY; unknown values fall back to the
 *   default rather than leaving a penguin unable to shoot.
 * @returns {Enemy | null}
 */
export function findTarget(enemies, origin, rangeSquared, priority = DEFAULT_TARGET_PRIORITY) {
  const score = PRIORITY_SCORE[priority] ?? PRIORITY_SCORE[DEFAULT_TARGET_PRIORITY];

  /** @type {Enemy | null} */
  let best = null;
  let bestScore = -Infinity;

  for (const enemy of enemies) {
    if (enemy.hp <= 0) continue;

    const pos = positionAt(enemy.progress);
    const dx = pos.x - origin.x;
    const dy = pos.y - origin.y;
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared > rangeSquared) continue;

    const value = score(enemy, distanceSquared);
    if (best === null || value > bestScore) {
      best = enemy;
      bestScore = value;
    }
  }

  return best;
}
