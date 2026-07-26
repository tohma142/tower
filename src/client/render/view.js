/**
 * Coordinates: tiles, world units, canvas pixels, and where the mouse actually is.
 *
 * Four spaces, and confusing any two of them produces a game that looks fine until you
 * click on it. Stated once:
 *
 *   tile      integers; `{x: 3, y: 7}` names a whole tile
 *   world     floats in tile units; tile (3,7)'s centre is (3.5, 7.5)
 *   canvas    device pixels in the canvas backing store
 *   client    CSS pixels in the browser viewport, what a MouseEvent reports
 *
 * The canvas is rendered at a fixed backing size and may be displayed at any CSS size,
 * so client and canvas pixels are generally *not* the same. Every function here is pure
 * and takes what it needs as arguments, which is what makes the whole lot testable
 * without a DOM.
 */

import { GRID_COLS, GRID_ROWS, RENDER_SCALE, TILE_PX } from '../../shared/constants.js';

/**
 * Pixels per tile in the canvas backing store.
 *
 * @param {number} [scale]
 * @returns {number}
 */
export function tilePixels(scale = RENDER_SCALE) {
  return TILE_PX * scale;
}

/**
 * Backing-store dimensions for the board.
 *
 * @param {number} [scale]
 * @returns {{ width: number, height: number }}
 */
export function canvasSize(scale = RENDER_SCALE) {
  const px = tilePixels(scale);
  return { width: GRID_COLS * px, height: GRID_ROWS * px };
}

/**
 * World position to canvas pixels.
 *
 * @param {{ x: number, y: number }} world
 * @param {number} [scale]
 * @returns {{ x: number, y: number }}
 */
export function worldToCanvas(world, scale = RENDER_SCALE) {
  const px = tilePixels(scale);
  return { x: world.x * px, y: world.y * px };
}

/**
 * Top-left canvas pixel of a tile.
 *
 * @param {number} tileX
 * @param {number} tileY
 * @param {number} [scale]
 * @returns {{ x: number, y: number }}
 */
export function tileToCanvas(tileX, tileY, scale = RENDER_SCALE) {
  const px = tilePixels(scale);
  return { x: tileX * px, y: tileY * px };
}

/**
 * Convert a viewport position into canvas backing-store pixels.
 *
 * The canvas is almost always displayed at a different size than its backing store —
 * scaled down to fit a window, or up on a large display. Using the event's coordinates
 * directly would put every click in the wrong tile, increasingly so towards the edges.
 *
 * @param {{ clientX: number, clientY: number }} event
 * @param {{ left: number, top: number, width: number, height: number }} rect The
 *   canvas's bounding rectangle in CSS pixels.
 * @param {{ width: number, height: number }} backing The canvas backing-store size.
 * @returns {{ x: number, y: number }}
 */
export function clientToCanvas(event, rect, backing) {
  // A zero-sized rect means the canvas is not laid out yet; mapping to the origin is
  // harmless and beats returning NaN, which would silently poison every downstream check.
  const scaleX = rect.width === 0 ? 0 : backing.width / rect.width;
  const scaleY = rect.height === 0 ? 0 : backing.height / rect.height;

  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
  };
}

/**
 * Canvas pixels to the tile underneath, or null if outside the board.
 *
 * Returns null rather than a clamped edge tile: a click outside the board is not a
 * click on its border, and clamping would let a stray click place a penguin.
 *
 * @param {{ x: number, y: number }} canvasPoint
 * @param {number} [scale]
 * @returns {{ x: number, y: number } | null}
 */
export function canvasToTile(canvasPoint, scale = RENDER_SCALE) {
  const px = tilePixels(scale);
  const x = Math.floor(canvasPoint.x / px);
  const y = Math.floor(canvasPoint.y / px);

  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || x >= GRID_COLS || y < 0 || y >= GRID_ROWS) return null;

  return { x, y };
}

/**
 * The whole path from a mouse event to a tile.
 *
 * @param {{ clientX: number, clientY: number }} event
 * @param {{ left: number, top: number, width: number, height: number }} rect
 * @param {{ width: number, height: number }} backing
 * @param {number} [scale]
 * @returns {{ x: number, y: number } | null}
 */
export function eventToTile(event, rect, backing, scale = RENDER_SCALE) {
  return canvasToTile(clientToCanvas(event, rect, backing), scale);
}
