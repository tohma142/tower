import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canvasSize,
  canvasToTile,
  clientToCanvas,
  eventToTile,
  tilePixels,
  tileToCanvas,
  worldToCanvas,
} from '../../src/client/render/view.js';
import { GRID_COLS, GRID_ROWS, RENDER_SCALE, TILE_PX } from '../../src/shared/constants.js';

describe('dimensions', () => {
  it('derives tile size from the art size and the render scale', () => {
    assert.equal(tilePixels(3), TILE_PX * 3);
    assert.equal(tilePixels(), TILE_PX * RENDER_SCALE);
  });

  it('sizes the canvas to hold the whole board', () => {
    const size = canvasSize(3);

    assert.equal(size.width, GRID_COLS * TILE_PX * 3);
    assert.equal(size.height, GRID_ROWS * TILE_PX * 3);
  });
});

describe('world to canvas', () => {
  it('puts the origin at the top-left corner', () => {
    assert.deepEqual(worldToCanvas({ x: 0, y: 0 }, 3), { x: 0, y: 0 });
  });

  it('puts a tile centre at the middle of its square', () => {
    const px = tilePixels(3);
    assert.deepEqual(worldToCanvas({ x: 2.5, y: 3.5 }, 3), { x: 2.5 * px, y: 3.5 * px });
  });

  it('agrees with tileToCanvas on a tile corner', () => {
    assert.deepEqual(tileToCanvas(4, 6, 3), worldToCanvas({ x: 4, y: 6 }, 3));
  });
});

describe('clientToCanvas', () => {
  const backing = { width: 960, height: 576 };

  it('is the identity when the canvas is displayed at its backing size', () => {
    const rect = { left: 0, top: 0, width: 960, height: 576 };
    assert.deepEqual(clientToCanvas({ clientX: 100, clientY: 50 }, rect, backing), { x: 100, y: 50 });
  });

  it('compensates when the canvas is displayed smaller', () => {
    // The canvas shrinks to fit a window constantly. Using event coordinates directly
    // would put every click in the wrong tile, and worse towards the right edge.
    const rect = { left: 0, top: 0, width: 480, height: 288 };
    assert.deepEqual(clientToCanvas({ clientX: 240, clientY: 144 }, rect, backing), { x: 480, y: 288 });
  });

  it('compensates when the canvas is displayed larger', () => {
    const rect = { left: 0, top: 0, width: 1920, height: 1152 };
    assert.deepEqual(clientToCanvas({ clientX: 960, clientY: 576 }, rect, backing), { x: 480, y: 288 });
  });

  it('accounts for the canvas not being at the page origin', () => {
    const rect = { left: 100, top: 40, width: 960, height: 576 };
    assert.deepEqual(clientToCanvas({ clientX: 130, clientY: 60 }, rect, backing), { x: 30, y: 20 });
  });

  it('returns finite numbers for a canvas that has not been laid out', () => {
    // A zero-sized rect happens on the first frame. NaN here would silently poison
    // every bounds check downstream.
    const point = clientToCanvas({ clientX: 10, clientY: 10 }, { left: 0, top: 0, width: 0, height: 0 }, backing);

    assert.ok(Number.isFinite(point.x));
    assert.ok(Number.isFinite(point.y));
  });
});

describe('canvasToTile', () => {
  const px = tilePixels(3);

  it('maps a point inside a tile to that tile', () => {
    assert.deepEqual(canvasToTile({ x: px * 2 + 5, y: px * 3 + 5 }, 3), { x: 2, y: 3 });
  });

  it('puts an exact boundary in the tile it starts', () => {
    assert.deepEqual(canvasToTile({ x: px * 2, y: px * 2 }, 3), { x: 2, y: 2 });
  });

  it('maps the last pixel of a tile to that tile, not the next', () => {
    assert.deepEqual(canvasToTile({ x: px * 2 - 1, y: px * 2 - 1 }, 3), { x: 1, y: 1 });
  });

  it('returns null outside the board rather than clamping to the edge', () => {
    // Clamping would let a click in the margin place a penguin on the border tile.
    assert.equal(canvasToTile({ x: -1, y: 0 }, 3), null);
    assert.equal(canvasToTile({ x: 0, y: -1 }, 3), null);
    assert.equal(canvasToTile({ x: GRID_COLS * px, y: 0 }, 3), null);
    assert.equal(canvasToTile({ x: 0, y: GRID_ROWS * px }, 3), null);
  });

  it('returns null for non-finite input', () => {
    assert.equal(canvasToTile({ x: NaN, y: 0 }, 3), null);
    assert.equal(canvasToTile({ x: Infinity, y: 0 }, 3), null);
  });

  it('covers every tile on the board and no more', () => {
    const seen = new Set();
    for (let x = 0; x < GRID_COLS; x += 1) {
      for (let y = 0; y < GRID_ROWS; y += 1) {
        const centre = { x: x * px + px / 2, y: y * px + px / 2 };
        const tile = canvasToTile(centre, 3);
        assert.deepEqual(tile, { x, y });
        seen.add(`${x},${y}`);
      }
    }
    assert.equal(seen.size, GRID_COLS * GRID_ROWS);
  });
});

describe('eventToTile', () => {
  it('takes a mouse event all the way to a tile through a scaled canvas', () => {
    const backing = canvasSize(3);
    const rect = { left: 20, top: 10, width: backing.width / 2, height: backing.height / 2 };
    const px = tilePixels(3);

    // Aim at the centre of tile (5,4) in canvas space, then halve it for display scale.
    const target = { x: 5 * px + px / 2, y: 4 * px + px / 2 };
    const event = { clientX: 20 + target.x / 2, clientY: 10 + target.y / 2 };

    assert.deepEqual(eventToTile(event, rect, backing, 3), { x: 5, y: 4 });
  });

  it('returns null for a click in the margin beside the board', () => {
    const backing = canvasSize(3);
    const rect = { left: 0, top: 0, width: backing.width, height: backing.height };

    assert.equal(eventToTile({ clientX: -5, clientY: 10 }, rect, backing, 3), null);
  });
});
