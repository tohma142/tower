/**
 * The board: its grid, the path enemies walk, and where penguins may stand.
 *
 * Shared by the server (which validates placements and moves enemies) and the client
 * (which draws the path and converts clicks to tiles). Both must agree exactly on what
 * is buildable, so there is one definition and no second copy.
 *
 * Two coordinate spaces, used consistently:
 *   - tile coords    integers, `{x: 3, y: 7}` names a whole tile
 *   - world coords   floats in tile units, where tile (3,7)'s centre is (3.5, 7.5)
 *
 * Enemies live in world coords so they move smoothly between tiles; placement and
 * buildability work in tile coords.
 */

import { GRID_COLS, GRID_ROWS } from './constants.js';

/**
 * @typedef {object} Point
 * @property {number} x
 * @property {number} y
 */

/**
 * Corners of the path, in tile coords, from spawn to iceberg.
 *
 * Every segment must be axis-aligned — the tile enumeration below walks one axis at a
 * time, and a diagonal would silently cover the wrong tiles. That invariant is checked
 * at load rather than trusted.
 *
 * @type {ReadonlyArray<Point>}
 */
export const PATH_WAYPOINTS = Object.freeze([
  Object.freeze({ x: 0, y: 2 }),
  Object.freeze({ x: 14, y: 2 }),
  Object.freeze({ x: 14, y: 5 }),
  Object.freeze({ x: 4, y: 5 }),
  Object.freeze({ x: 4, y: 8 }),
  Object.freeze({ x: 16, y: 8 }),
  Object.freeze({ x: 16, y: 10 }),
  Object.freeze({ x: 11, y: 10 }),
]);

/** Where enemies enter the board. */
export const SPAWN_TILE = PATH_WAYPOINTS[0];

/** The iceberg. Enemies reaching it deal their damage and are removed. */
export const ICEBERG_TILE = PATH_WAYPOINTS[PATH_WAYPOINTS.length - 1];

/**
 * Key a tile for set/map lookup. Tile coords only — passing world coords silently
 * produces a key that matches nothing.
 *
 * @param {number} x Tile column.
 * @param {number} y Tile row.
 * @returns {string}
 */
export function tileKey(x, y) {
  return `${x},${y}`;
}

/**
 * Validate the waypoint list and enumerate every tile the path covers.
 *
 * @returns {{ tiles: Set<string>, segments: Array<{ from: Point, to: Point, length: number, start: number }>, length: number }}
 */
function buildPath() {
  /** @type {Set<string>} */
  const tiles = new Set();
  /** @type {Array<{ from: Point, to: Point, length: number, start: number }>} */
  const segments = [];
  let total = 0;

  for (let i = 0; i < PATH_WAYPOINTS.length - 1; i += 1) {
    const from = PATH_WAYPOINTS[i];
    const to = PATH_WAYPOINTS[i + 1];

    const dx = to.x - from.x;
    const dy = to.y - from.y;

    if (dx !== 0 && dy !== 0) {
      throw new Error(
        `path segment ${i} from (${from.x},${from.y}) to (${to.x},${to.y}) is diagonal; segments must be axis-aligned`,
      );
    }
    if (dx === 0 && dy === 0) {
      throw new Error(`path segment ${i} is zero-length at (${from.x},${from.y})`);
    }

    const steps = Math.abs(dx) + Math.abs(dy);
    const stepX = Math.sign(dx);
    const stepY = Math.sign(dy);

    for (let s = 0; s <= steps; s += 1) {
      const x = from.x + stepX * s;
      const y = from.y + stepY * s;
      if (x < 0 || x >= GRID_COLS || y < 0 || y >= GRID_ROWS) {
        throw new Error(`path leaves the board at (${x},${y})`);
      }
      tiles.add(tileKey(x, y));
    }

    segments.push({ from, to, length: steps, start: total });
    total += steps;
  }

  return { tiles, segments, length: total };
}

const PATH = buildPath();

/** Every tile the path covers, as `"x,y"` keys. */
export const PATH_TILES = PATH.tiles;

/** Total path length in tiles. An enemy's progress runs from 0 to this. */
export const PATH_LENGTH = PATH.length;

/**
 * Convert progress along the path into a world position.
 *
 * @param {number} distance Tiles travelled from spawn. Clamped to the path, so an enemy
 *   that has overshot the iceberg reports the iceberg rather than a position off-board.
 * @returns {Point} World coords (tile units, tile centres at .5).
 */
export function positionAt(distance) {
  const d = Math.min(Math.max(distance, 0), PATH.length);

  for (const seg of PATH.segments) {
    const local = d - seg.start;
    if (local <= seg.length) {
      const t = seg.length === 0 ? 0 : local / seg.length;
      return {
        x: seg.from.x + (seg.to.x - seg.from.x) * t + 0.5,
        y: seg.from.y + (seg.to.y - seg.from.y) * t + 0.5,
      };
    }
  }

  // Only reachable when d === total length and floating point lands past the last
  // segment; the iceberg is the correct answer either way.
  const last = PATH_WAYPOINTS[PATH_WAYPOINTS.length - 1];
  return { x: last.x + 0.5, y: last.y + 0.5 };
}

/**
 * @param {number} x Tile column.
 * @param {number} y Tile row.
 * @returns {boolean} Whether the tile is on the board.
 */
export function isInBounds(x, y) {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < GRID_COLS && y >= 0 && y < GRID_ROWS;
}

/**
 * @param {number} x Tile column.
 * @param {number} y Tile row.
 * @returns {boolean} Whether enemies walk over this tile.
 */
export function isPathTile(x, y) {
  return PATH_TILES.has(tileKey(x, y));
}

/**
 * Whether a penguin may stand here, ignoring what is already placed.
 *
 * Tiles adjacent to the path are deliberately buildable. Blocking them would remove the
 * central placement decision in a tower defense — how close to the path to commit — and
 * would leave short-range penguins with nowhere useful to stand.
 *
 * Occupancy is *not* checked here: this function is about the board, and what is already
 * built is game state. The command layer checks both.
 *
 * @param {number} x Tile column.
 * @param {number} y Tile row.
 * @returns {boolean}
 */
export function isBuildable(x, y) {
  return isInBounds(x, y) && !isPathTile(x, y);
}

/**
 * Squared distance between two world points.
 *
 * Squared, because range checks compare against a squared radius and the square root
 * is pure cost — this runs for every tower against every enemy, every tick.
 *
 * @param {Point} a
 * @param {Point} b
 * @returns {number}
 */
export function distanceSquared(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}
