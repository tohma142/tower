/**
 * Smoothing a 20 Hz simulation into a 60 Hz picture.
 *
 * The server ticks 20 times a second. Drawing the newest snapshot each frame would show
 * the world in 50ms jumps — visibly steppy, and worse whenever a packet arrives late.
 *
 * Instead the client renders slightly in the past. It picks a render time of
 * `now - RENDER_DELAY_MS`, finds the two snapshots that straddle it, and draws the
 * interpolation between them. The cost is a fixed, imperceptible input latency; the
 * benefit is that motion is smooth even when packets are not evenly spaced.
 *
 * This module is pure — no canvas, no clock, no DOM — because it is where the client's
 * correctness actually lives.
 */

/**
 * @typedef {object} BufferedSnapshot
 * @property {import('../../game/state.js').Snapshot} snapshot
 * @property {number} at Local timestamp when it arrived.
 */

/**
 * Linear interpolation.
 *
 * @param {number} a
 * @param {number} b
 * @param {number} t Fraction in 0..1.
 * @returns {number}
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Drop snapshots older than anything the renderer could still want.
 *
 * Without this the buffer grows for the length of the session — 20 snapshots a second,
 * each holding every entity on the board.
 *
 * @param {BufferedSnapshot[]} buffer Mutated in place.
 * @param {number} nowMs
 * @param {number} maxAgeMs
 * @returns {void}
 */
export function pruneBuffer(buffer, nowMs, maxAgeMs) {
  // Keep one entry older than the cutoff: it is the left-hand side of the pair the
  // renderer interpolates from. Dropping it would leave nothing to interpolate out of
  // and the world would snap.
  let keepFrom = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (nowMs - buffer[i].at <= maxAgeMs) break;
    keepFrom = i;
  }
  if (keepFrom > 0) buffer.splice(0, keepFrom);
}

/**
 * Find the pair of snapshots straddling a render time.
 *
 * @param {ReadonlyArray<BufferedSnapshot>} buffer Ascending by `at`.
 * @param {number} renderAtMs
 * @returns {{ from: BufferedSnapshot, to: BufferedSnapshot, t: number } | null}
 */
export function findPair(buffer, renderAtMs) {
  if (buffer.length === 0) return null;

  if (buffer.length === 1) {
    return { from: buffer[0], to: buffer[0], t: 0 };
  }

  // Before anything we have: show the oldest rather than extrapolating backwards.
  if (renderAtMs <= buffer[0].at) {
    return { from: buffer[0], to: buffer[0], t: 0 };
  }

  for (let i = 0; i < buffer.length - 1; i += 1) {
    const from = buffer[i];
    const to = buffer[i + 1];
    if (renderAtMs <= to.at) {
      const span = to.at - from.at;
      // Two snapshots stamped at the same instant would divide by zero.
      const t = span <= 0 ? 0 : (renderAtMs - from.at) / span;
      return { from, to, t };
    }
  }

  // Past the newest: hold on the latest rather than extrapolating. Guessing ahead makes
  // enemies overshoot and then snap back the moment the next packet lands, which reads
  // far worse than a brief pause.
  const newest = buffer[buffer.length - 1];
  return { from: newest, to: newest, t: 0 };
}

/**
 * Build the view to draw for a given render time.
 *
 * Discrete state — phase, wave, fish, iceberg health — is taken from the *earlier*
 * snapshot. Taking it from the later one would show the player a future they have not
 * been rendered up to yet, so a wave counter could tick over before the last enemy of
 * the previous wave finished animating.
 *
 * @param {ReadonlyArray<BufferedSnapshot>} buffer
 * @param {number} renderAtMs
 * @returns {(import('../../game/state.js').Snapshot & { interpolated: true }) | null}
 */
export function sampleAt(buffer, renderAtMs) {
  const pair = findPair(buffer, renderAtMs);
  if (pair === null) return null;

  const { from, to, t } = pair;
  const base = from.snapshot;

  if (from === to || t <= 0) {
    return { ...base, interpolated: true };
  }

  /** @type {Map<number, import('../../game/state.js').SnapshotEnemy>} */
  const nextEnemies = new Map();
  for (const enemy of to.snapshot.enemies) nextEnemies.set(enemy.id, enemy);

  /** @type {Map<number, import('../../game/state.js').SnapshotProjectile>} */
  const nextProjectiles = new Map();
  for (const projectile of to.snapshot.projectiles) nextProjectiles.set(projectile.id, projectile);

  return {
    ...base,
    interpolated: true,

    enemies: base.enemies.map((enemy) => {
      const next = nextEnemies.get(enemy.id);
      // An enemy absent from the later snapshot died in between. Leave it where it was
      // rather than guessing; it disappears when the render time passes that snapshot.
      if (next === undefined) return enemy;
      return {
        ...enemy,
        progress: lerp(enemy.progress, next.progress, t),
        hp: lerp(enemy.hp, next.hp, t),
      };
    }),

    projectiles: base.projectiles.map((projectile) => {
      const next = nextProjectiles.get(projectile.id);
      if (next === undefined) return projectile;
      return {
        ...projectile,
        x: lerp(projectile.x, next.x, t),
        y: lerp(projectile.y, next.y, t),
      };
    }),
  };
}
