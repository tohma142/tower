/**
 * What a unit's stat card says, and where it goes.
 *
 * Kept separate from the drawing so the two decidable parts — which numbers a unit
 * reports, and where the card sits so it stays on the board — are pure functions with
 * tests. What remains in `draw.js` is filling rectangles and text, which nothing
 * automated can usefully check.
 *
 * Numbers here are the unit's *current* values, not its table values. A level-2 Sniper
 * reports 21 damage, because a card that showed 12 while the penguin hit for 21 would be
 * worse than no card at all.
 */

import { MAX_TOWER_LEVEL, isCombatTower, levelMultiplier } from '../../shared/constants.js';

/**
 * Trim a computed stat to something a player can read.
 *
 * Level multipliers are fractional, so damage lands on values like 10.5. Two decimals
 * would be noise and rounding to an integer would misreport a real difference, so this
 * keeps at most one decimal and drops a trailing zero.
 *
 * @param {number} value
 * @returns {string}
 */
export function formatStat(value) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * The card's heading: the unit's name, and its level when levels are in play.
 *
 * @param {import('../../shared/constants.js').TowerType} spec
 * @param {number} [level]
 * @returns {string}
 */
export function cardTitle(spec, level = 1) {
  const name = spec.name.toUpperCase();
  return MAX_TOWER_LEVEL > 1 ? `${name}  L${level}` : name;
}

/**
 * The stat rows for a unit at a given level.
 *
 * A combat unit reports what it does to enemies; a support unit reports what it pays.
 * Listing damage as `0` for a Fisher would be technically true and actively misleading —
 * it reads as a broken gun rather than as a unit that has no gun.
 *
 * @param {import('../../shared/constants.js').TowerType} spec
 * @param {number} [level]
 * @returns {Array<{ label: string, value: string }>}
 */
export function statLines(spec, level = 1) {
  const multiplier = levelMultiplier(level);

  if (!isCombatTower(spec)) {
    return [{ label: 'fish/wave', value: formatStat(spec.income * multiplier) }];
  }

  const rows = [
    { label: 'dmg', value: formatStat(spec.damage * multiplier) },
    { label: 'rng', value: formatStat(spec.range) },
    { label: 'rate', value: `${formatStat(spec.fireRate)}/s` },
  ];

  // Only when it has one. A `splash 0` row on the Pistol is a row that never changes and
  // never matters, and every row costs height on a card that sits over the board.
  if (spec.splashRadius > 0) {
    rows.push({ label: 'splash', value: formatStat(spec.splashRadius) });
  }

  return rows;
}

/**
 * How wide and tall the card needs to be, in canvas pixels.
 *
 * Measured from character counts rather than `ctx.measureText`, so the layout is a pure
 * function of the content and can be tested without a canvas. The font is monospace, so
 * character counts are exact rather than an approximation.
 *
 * @param {object} content
 * @param {string} content.title
 * @param {Array<{ label: string, value: string }>} content.lines
 * @param {object} metrics
 * @param {number} metrics.charWidth
 * @param {number} metrics.lineHeight
 * @param {number} metrics.padding
 * @returns {{ width: number, height: number, columns: number }}
 */
export function cardSize({ title, lines }, { charWidth, lineHeight, padding }) {
  const labelWidth = Math.max(0, ...lines.map((l) => l.label.length));
  const valueWidth = Math.max(0, ...lines.map((l) => l.value.length));

  // One space between label and value; the title is not padded to the columns.
  const bodyColumns = lines.length === 0 ? 0 : labelWidth + 1 + valueWidth;
  const columns = Math.max(title.length, bodyColumns);

  return {
    columns,
    width: Math.ceil(columns * charWidth + padding * 2),
    height: Math.ceil((lines.length + 1) * lineHeight + padding * 2),
  };
}

/**
 * Where to put the card so it stays on the board.
 *
 * Preferred position is above and to the right of the tile, which keeps the penguin
 * itself visible. Near an edge it flips rather than clamps: a clamped card would sit on
 * top of the unit it describes, and against the right-hand wall — where the iceberg is,
 * and where the interesting decisions happen — that is exactly when you least want the
 * board covered.
 *
 * @param {object} options
 * @param {{ x: number, y: number }} options.tile Tile coordinates.
 * @param {{ width: number, height: number }} options.card
 * @param {number} options.tilePx Canvas pixels per tile.
 * @param {{ width: number, height: number }} options.board Canvas size.
 * @param {number} [options.gap] Pixels between the tile and the card.
 * @returns {{ x: number, y: number, flippedX: boolean, flippedY: boolean }}
 */
export function cardPosition({ tile, card, tilePx, board, gap = 4 }) {
  const tileLeft = tile.x * tilePx;
  const tileTop = tile.y * tilePx;

  let x = tileLeft + tilePx + gap;
  let flippedX = false;
  if (x + card.width > board.width) {
    x = tileLeft - card.width - gap;
    flippedX = true;
  }

  let y = tileTop - card.height - gap;
  let flippedY = false;
  if (y < 0) {
    y = tileTop + tilePx + gap;
    flippedY = true;
  }

  // Both flips exhausted and it still does not fit — a board smaller than the card.
  // Clamping is the last resort, and better than drawing off-canvas where it vanishes.
  x = Math.max(0, Math.min(x, board.width - card.width));
  y = Math.max(0, Math.min(y, board.height - card.height));

  return { x, y, flippedX, flippedY };
}
