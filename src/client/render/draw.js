/**
 * Drawing the board.
 *
 * Everything decidable — where things are, how far along the path, which tile a click
 * landed on — lives in `view.js`, `interpolate.js`, and the shared map module, all of
 * which are pure and tested. What remains here is the blitting itself.
 *
 * The whole scene is redrawn every frame. At this entity count that is far cheaper than
 * tracking dirty regions, and it removes a whole class of stale-pixel bug.
 */

import { GRID_COLS, GRID_ROWS, TOWER_TYPES } from '../../shared/constants.js';
import { ICEBERG_TILE, isBuildable, isPathTile, positionAt } from '../../shared/map.js';

import { tilePixels, tileToCanvas, worldToCanvas } from './view.js';

const COLOURS = Object.freeze({
  ground: '#1b1b1b',
  groundAlt: '#202020',
  path: '#3a3a3a',
  pathEdge: '#4d4d4d',
  grid: '#262626',
  blocked: '#161616',
  hpBack: '#0a0a0a',
  hpFill: '#e8e8e8',
  projectile: '#f2f2f2',
  splash: '#c8c8c8',
  ghostOk: 'rgba(240, 240, 240, 0.45)',
  ghostBad: 'rgba(240, 240, 240, 0.12)',
  range: 'rgba(232, 232, 232, 0.10)',
  rangeEdge: 'rgba(232, 232, 232, 0.35)',
  ownerMark: '#f2f2f2',
});

/** Distinct markers so each player can pick their own penguins out of a crowded board. */
const OWNER_MARKS = Object.freeze(['', '·', ':', '⋮']);

/**
 * Paint the static board: ground, path, and grid.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} scale
 * @returns {void}
 */
export function drawBoard(ctx, scale) {
  const px = tilePixels(scale);

  for (let x = 0; x < GRID_COLS; x += 1) {
    for (let y = 0; y < GRID_ROWS; y += 1) {
      const { x: sx, y: sy } = tileToCanvas(x, y, scale);

      if (isPathTile(x, y)) {
        ctx.fillStyle = COLOURS.path;
      } else if (!isBuildable(x, y)) {
        ctx.fillStyle = COLOURS.blocked;
      } else {
        // A faint checker keeps the grid legible without drawing a line on every tile.
        ctx.fillStyle = (x + y) % 2 === 0 ? COLOURS.ground : COLOURS.groundAlt;
      }
      ctx.fillRect(sx, sy, px, px);
    }
  }

  // Outline the path so its shape reads instantly, which is what a player plans around.
  ctx.strokeStyle = COLOURS.pathEdge;
  ctx.lineWidth = Math.max(1, Math.floor(scale / 2));
  for (let x = 0; x < GRID_COLS; x += 1) {
    for (let y = 0; y < GRID_ROWS; y += 1) {
      if (!isPathTile(x, y)) continue;
      const { x: sx, y: sy } = tileToCanvas(x, y, scale);

      // Only edges facing off-path, so the interior stays clean.
      if (!isPathTile(x, y - 1)) strokeSegment(ctx, sx, sy, sx + px, sy);
      if (!isPathTile(x, y + 1)) strokeSegment(ctx, sx, sy + px, sx + px, sy + px);
      if (!isPathTile(x - 1, y)) strokeSegment(ctx, sx, sy, sx, sy + px);
      if (!isPathTile(x + 1, y)) strokeSegment(ctx, sx + px, sy, sx + px, sy + px);
    }
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 * @returns {void}
 */
function strokeSegment(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/**
 * Blit a sprite centred on a world position.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLCanvasElement} sprite
 * @param {{ x: number, y: number }} world
 * @param {number} scale
 * @returns {void}
 */
function blitCentred(ctx, sprite, world, scale) {
  const { x, y } = worldToCanvas(world, scale);
  // Rounded to whole pixels: drawing pixel art at a fractional offset re-samples it and
  // the crispness the integer scale bought is thrown away.
  ctx.drawImage(sprite, Math.round(x - sprite.width / 2), Math.round(y - sprite.height / 2));
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('../../game/state.js').Snapshot} view
 * @param {{ penguins: Record<string, HTMLCanvasElement>, enemies: Record<string, HTMLCanvasElement>, iceberg: HTMLCanvasElement }} sprites
 * @param {number} scale
 * @param {ReadonlyArray<string>} playerOrder Player ids, for owner markers.
 * @returns {void}
 */
export function drawEntities(ctx, view, sprites, scale, playerOrder) {
  const px = tilePixels(scale);

  blitCentred(ctx, sprites.iceberg, { x: ICEBERG_TILE.x + 0.5, y: ICEBERG_TILE.y + 0.5 }, scale);

  for (const tower of view.towers) {
    const sprite = sprites.penguins[tower.type];
    if (sprite === undefined) continue;
    blitCentred(ctx, sprite, { x: tower.x + 0.5, y: tower.y + 0.5 }, scale);

    // A small marker so a player can find their own penguins on a crowded board.
    const index = playerOrder.indexOf(tower.owner);
    const mark = OWNER_MARKS[index] ?? '';
    if (mark !== '') {
      const { x: sx, y: sy } = tileToCanvas(tower.x, tower.y, scale);
      ctx.fillStyle = COLOURS.ownerMark;
      ctx.font = `${Math.round(px * 0.4)}px ui-monospace, monospace`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(mark, sx + px - 1, sy + 1);
    }
  }

  for (const enemy of view.enemies) {
    const sprite = sprites.enemies[enemy.type];
    if (sprite === undefined) continue;

    const world = positionAt(enemy.progress);
    blitCentred(ctx, sprite, world, scale);

    // Health bar, only once damaged — a board of full bars is noise.
    if (enemy.hp < 0.999) {
      const { x, y } = worldToCanvas(world, scale);
      const width = Math.round(px * 0.7);
      const height = Math.max(2, Math.round(scale));
      const left = Math.round(x - width / 2);
      const top = Math.round(y - px * 0.55);

      ctx.fillStyle = COLOURS.hpBack;
      ctx.fillRect(left - 1, top - 1, width + 2, height + 2);
      ctx.fillStyle = COLOURS.hpFill;
      ctx.fillRect(left, top, Math.round(width * Math.max(0, enemy.hp)), height);
    }
  }

  for (const projectile of view.projectiles) {
    const { x, y } = worldToCanvas(projectile, scale);
    const size = projectile.splash ? Math.max(3, scale * 2) : Math.max(2, scale);
    ctx.fillStyle = projectile.splash ? COLOURS.splash : COLOURS.projectile;
    ctx.fillRect(Math.round(x - size / 2), Math.round(y - size / 2), size, size);
  }
}

/**
 * Draw the placement preview under the cursor.
 *
 * Shown before the server has confirmed anything: the range circle and a translucent
 * penguin, or a dimmed marker when the tile cannot take one. This is the only
 * optimistic thing the client does, and it is removed the moment a snapshot or a
 * rejection arrives.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ tile: { x: number, y: number }, towerType: string, allowed: boolean }} ghost
 * @param {Record<string, HTMLCanvasElement>} penguins
 * @param {number} scale
 * @returns {void}
 */
export function drawGhost(ctx, ghost, penguins, scale) {
  const px = tilePixels(scale);
  const spec = TOWER_TYPES[ghost.towerType];
  const centre = worldToCanvas({ x: ghost.tile.x + 0.5, y: ghost.tile.y + 0.5 }, scale);

  if (ghost.allowed && spec !== undefined) {
    ctx.fillStyle = COLOURS.range;
    ctx.strokeStyle = COLOURS.rangeEdge;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, spec.range * px, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  const sprite = penguins[ghost.towerType];
  if (sprite === undefined) return;

  ctx.save();
  ctx.globalAlpha = ghost.allowed ? 0.55 : 0.18;
  blitCentred(ctx, sprite, { x: ghost.tile.x + 0.5, y: ghost.tile.y + 0.5 }, scale);
  ctx.restore();

  ctx.strokeStyle = ghost.allowed ? COLOURS.ghostOk : COLOURS.ghostBad;
  ctx.lineWidth = Math.max(1, Math.floor(scale / 2));
  const corner = tileToCanvas(ghost.tile.x, ghost.tile.y, scale);
  ctx.strokeRect(corner.x + 1, corner.y + 1, px - 2, px - 2);
}

/**
 * Highlight the range of every placed penguin of a given owner. Used while a build is
 * selected, so coverage gaps are visible before committing fish.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('../../game/state.js').Snapshot} view
 * @param {number} scale
 * @returns {void}
 */
export function drawTowerRanges(ctx, view, scale) {
  const px = tilePixels(scale);
  ctx.strokeStyle = COLOURS.rangeEdge;
  ctx.lineWidth = 1;

  for (const tower of view.towers) {
    const spec = TOWER_TYPES[tower.type];
    if (spec === undefined) continue;
    const centre = worldToCanvas({ x: tower.x + 0.5, y: tower.y + 0.5 }, scale);
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, spec.range * px, 0, Math.PI * 2);
    ctx.stroke();
  }
}

