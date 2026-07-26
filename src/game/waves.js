/**
 * Turning the wave table into a spawn timetable.
 *
 * The table in `constants.js` describes waves declaratively — "twelve walkers, 600ms
 * apart, starting three seconds in". This module flattens that into an ordered list of
 * timestamped spawns, which is the only form the tick loop cares about. Keeping the
 * expansion here means balance edits never touch simulation code.
 */

import { TOTAL_WAVES, WAVES } from '../shared/constants.js';

/**
 * One scheduled arrival.
 *
 * @typedef {object} ScheduledSpawn
 * @property {number} atMs Milliseconds after the wave began.
 * @property {string} type Key into ENEMY_TYPES.
 */

/**
 * Expand a wave definition into an ordered spawn timetable.
 *
 * Groups within a wave overlap freely — that is how a wave of walkers with a brute
 * dropped into the middle is expressed — so the flattened list is sorted by time. The
 * sort is stabilised on group order, because a tie between two spawns at the same
 * millisecond must resolve the same way every run for tests to be meaningful.
 *
 * @param {number} waveNumber One-based, 1..TOTAL_WAVES.
 * @returns {ScheduledSpawn[]} Spawns in ascending time order.
 * @throws {RangeError} If the wave number is outside the defined range.
 */
export function buildSpawnSchedule(waveNumber) {
  if (!Number.isInteger(waveNumber) || waveNumber < 1 || waveNumber > TOTAL_WAVES) {
    throw new RangeError(`wave must be an integer in 1..${TOTAL_WAVES}, got: ${waveNumber}`);
  }

  const wave = WAVES[waveNumber - 1];

  /** @type {Array<{ atMs: number, type: string, order: number }>} */
  const spawns = [];
  let order = 0;

  for (const group of wave) {
    for (let i = 0; i < group.count; i += 1) {
      spawns.push({ atMs: group.delayMs + i * group.spacingMs, type: group.type, order });
      order += 1;
    }
  }

  spawns.sort((a, b) => (a.atMs === b.atMs ? a.order - b.order : a.atMs - b.atMs));

  return spawns.map(({ atMs, type }) => ({ atMs, type }));
}

/**
 * Total enemies in a wave. Used for progress display and to know when spawning is done.
 *
 * @param {number} waveNumber One-based.
 * @returns {number}
 */
export function waveEnemyCount(waveNumber) {
  if (!Number.isInteger(waveNumber) || waveNumber < 1 || waveNumber > TOTAL_WAVES) {
    throw new RangeError(`wave must be an integer in 1..${TOTAL_WAVES}, got: ${waveNumber}`);
  }
  return WAVES[waveNumber - 1].reduce((sum, group) => sum + group.count, 0);
}

/**
 * How long a wave spends spawning, ignoring how long the last enemy takes to walk.
 *
 * @param {number} waveNumber One-based.
 * @returns {number} Milliseconds from wave start to the final spawn.
 */
export function waveSpawnDurationMs(waveNumber) {
  const schedule = buildSpawnSchedule(waveNumber);
  return schedule.length === 0 ? 0 : schedule[schedule.length - 1].atMs;
}
