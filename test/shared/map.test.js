import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GRID_COLS, GRID_ROWS } from '../../src/shared/constants.js';
import {
  ICEBERG_TILE,
  PATH_LENGTH,
  PATH_TILES,
  PATH_WAYPOINTS,
  SPAWN_TILE,
  distanceSquared,
  isBuildable,
  isInBounds,
  isPathTile,
  positionAt,
  tileKey,
} from '../../src/shared/map.js';

describe('path definition', () => {
  it('keeps every waypoint on the board', () => {
    for (const wp of PATH_WAYPOINTS) {
      assert.ok(isInBounds(wp.x, wp.y), `waypoint (${wp.x},${wp.y}) is off-board`);
    }
  });

  it('uses only axis-aligned segments', () => {
    // The tile enumeration walks one axis at a time; a diagonal would mark the wrong
    // tiles as path and let players build somewhere enemies actually walk.
    for (let i = 0; i < PATH_WAYPOINTS.length - 1; i += 1) {
      const a = PATH_WAYPOINTS[i];
      const b = PATH_WAYPOINTS[i + 1];
      assert.ok(a.x === b.x || a.y === b.y, `segment ${i} is diagonal`);
      assert.ok(a.x !== b.x || a.y !== b.y, `segment ${i} is zero-length`);
    }
  });

  it('measures PATH_LENGTH as the sum of its segments', () => {
    let expected = 0;
    for (let i = 0; i < PATH_WAYPOINTS.length - 1; i += 1) {
      const a = PATH_WAYPOINTS[i];
      const b = PATH_WAYPOINTS[i + 1];
      expected += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    }
    assert.equal(PATH_LENGTH, expected);
  });

  it('marks the spawn and iceberg tiles as path', () => {
    assert.ok(isPathTile(SPAWN_TILE.x, SPAWN_TILE.y));
    assert.ok(isPathTile(ICEBERG_TILE.x, ICEBERG_TILE.y));
  });

  it('covers a contiguous run of tiles with no gaps', () => {
    // Walk the path in small steps and confirm every position lands on a path tile.
    // A gap would let an enemy appear to cut a corner across buildable ground.
    for (let d = 0; d <= PATH_LENGTH; d += 0.25) {
      const p = positionAt(d);
      const tx = Math.floor(p.x);
      const ty = Math.floor(p.y);
      assert.ok(isPathTile(tx, ty), `position at ${d} lands on non-path tile (${tx},${ty})`);
    }
  });
});

describe('positionAt', () => {
  it('starts at the centre of the spawn tile', () => {
    assert.deepEqual(positionAt(0), { x: SPAWN_TILE.x + 0.5, y: SPAWN_TILE.y + 0.5 });
  });

  it('ends at the centre of the iceberg tile', () => {
    assert.deepEqual(positionAt(PATH_LENGTH), { x: ICEBERG_TILE.x + 0.5, y: ICEBERG_TILE.y + 0.5 });
  });

  it('clamps rather than extrapolating off the board', () => {
    // An enemy that overshoots in the same tick it is removed must not report a
    // position outside the map, which would draw a sprite in the void.
    assert.deepEqual(positionAt(-10), positionAt(0));
    assert.deepEqual(positionAt(PATH_LENGTH + 50), positionAt(PATH_LENGTH));
  });

  it('advances monotonically along the path', () => {
    let previous = positionAt(0);
    for (let d = 0.5; d <= PATH_LENGTH; d += 0.5) {
      const current = positionAt(d);
      const moved = distanceSquared(previous, current);
      assert.ok(moved > 0, `no movement between ${d - 0.5} and ${d}`);
      previous = current;
    }
  });

  it('travels one tile of distance per unit of progress', () => {
    // Speeds are quoted in tiles per second, so this equivalence is what makes the
    // tuning table mean what it says.
    for (const d of [1, 5, 10]) {
      const moved = Math.sqrt(distanceSquared(positionAt(d), positionAt(d + 1)));
      assert.ok(Math.abs(moved - 1) < 1e-9, `progress ${d}->${d + 1} moved ${moved} tiles`);
    }
  });
});

describe('buildability', () => {
  it('refuses tiles the path runs over', () => {
    for (const key of PATH_TILES) {
      const [x, y] = key.split(',').map(Number);
      assert.equal(isBuildable(x, y), false, `(${x},${y}) is path and must not be buildable`);
    }
  });

  it('allows tiles adjacent to the path', () => {
    // Deliberate: blocking these would remove the core placement decision and strand
    // short-range penguins. Asserted so a future change has to be intentional.
    const adjacentBuildable = [...PATH_TILES].some((key) => {
      const [x, y] = key.split(',').map(Number);
      return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => isBuildable(x + dx, y + dy));
    });
    assert.ok(adjacentBuildable, 'at least some tiles beside the path must be buildable');
  });

  it('refuses everything off the board', () => {
    assert.equal(isBuildable(-1, 0), false);
    assert.equal(isBuildable(0, -1), false);
    assert.equal(isBuildable(GRID_COLS, 0), false);
    assert.equal(isBuildable(0, GRID_ROWS), false);
  });

  it('refuses fractional and non-numeric tiles', () => {
    // Tile coords arrive from a client. A float would key an occupancy map that no
    // other lookup can ever match, silently allowing unlimited stacking.
    assert.equal(isBuildable(1.5, 2), false);
    assert.equal(isBuildable(2, 3.7), false);
    assert.equal(isBuildable(NaN, 0), false);
    assert.equal(isBuildable(Infinity, 0), false);
  });

  it('leaves a workable amount of the board buildable', () => {
    let buildable = 0;
    for (let x = 0; x < GRID_COLS; x += 1) {
      for (let y = 0; y < GRID_ROWS; y += 1) {
        if (isBuildable(x, y)) buildable += 1;
      }
    }
    const total = GRID_COLS * GRID_ROWS;
    assert.equal(buildable, total - PATH_TILES.size);
    assert.ok(buildable > total * 0.5, 'over half the board should be buildable');
  });
});

describe('tileKey', () => {
  it('produces distinct keys for distinct tiles', () => {
    assert.notEqual(tileKey(1, 2), tileKey(2, 1));
    assert.equal(tileKey(3, 4), tileKey(3, 4));
  });

  it('does not collide across multi-digit coordinates', () => {
    // A naive `${x}${y}` would make (1,23) and (12,3) the same key.
    assert.notEqual(tileKey(1, 23), tileKey(12, 3));
  });
});

describe('distanceSquared', () => {
  it('returns squared distance, not distance', () => {
    assert.equal(distanceSquared({ x: 0, y: 0 }, { x: 3, y: 4 }), 25);
  });

  it('is zero for identical points and symmetric otherwise', () => {
    assert.equal(distanceSquared({ x: 2, y: 2 }, { x: 2, y: 2 }), 0);
    assert.equal(
      distanceSquared({ x: 1, y: 5 }, { x: 4, y: 9 }),
      distanceSquared({ x: 4, y: 9 }, { x: 1, y: 5 }),
    );
  });
});
