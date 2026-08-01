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
 *
 * Where the next level would change a number, the card shows both — `21 → 36` — so the
 * question the player is actually asking ("is this upgrade worth 96 fish?") is answered
 * on the card instead of in their head.
 */

import {
  MAX_TOWER_LEVEL,
  isCombatTower,
  levelMultiplier,
  upgradeCostFor,
} from '../../shared/constants.js';

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
 * A stat's current value, and where upgrading would take it.
 *
 * The arrow appears only when the number actually moves. A `7 → 7` row is noise dressed
 * up as information, and at the level cap there is nothing to preview at all.
 *
 * @param {string} label
 * @param {number} base Table value at level 1.
 * @param {number} multiplier Multiplier at the current level.
 * @param {number | null} nextMultiplier Multiplier one level up, or null at the cap.
 * @returns {{ label: string, value: string }}
 */
function growthRow(label, base, multiplier, nextMultiplier) {
  const now = formatStat(base * multiplier);
  if (nextMultiplier === null) return { label, value: now };

  const next = formatStat(base * nextMultiplier);
  return { label, value: next === now ? now : `${now} → ${next}` };
}

/**
 * The stat rows for a unit at a given level.
 *
 * A combat unit reports what it does to enemies; a support unit reports what it pays.
 * Listing damage as `0` for a Fisher would be technically true and actively misleading —
 * it reads as a broken gun rather than as a unit that has no gun.
 *
 * Every unit gets an `upgrade` row: the price of the next level, or `maxed` at the cap.
 * A preview of what an upgrade buys is worth little without what it costs.
 *
 * @param {import('../../shared/constants.js').TowerType} spec
 * @param {number} [level]
 * @returns {Array<{ label: string, value: string }>}
 */
export function statLines(spec, level = 1) {
  const multiplier = levelMultiplier(level);
  const nextMultiplier = level < MAX_TOWER_LEVEL ? levelMultiplier(level + 1) : null;

  /** @type {Array<{ label: string, value: string }>} */
  const rows = [];

  if (!isCombatTower(spec)) {
    rows.push(growthRow('fish/wave', spec.income, multiplier, nextMultiplier));
  } else {
    rows.push(growthRow('dmg', spec.damage, multiplier, nextMultiplier));
    rows.push({ label: 'rng', value: formatStat(spec.range) });
    rows.push({ label: 'rate', value: `${formatStat(spec.fireRate)}/s` });

    // Only when it has one. A `splash 0` row on the Pistol is a row that never changes and
    // never matters, and every row costs height on a card that sits over the board.
    if (spec.splashRadius > 0) {
      rows.push({ label: 'splash', value: formatStat(spec.splashRadius) });
    }
  }

  if (MAX_TOWER_LEVEL > 1) {
    // Read from the cap rather than from `upgradeCostFor` returning Infinity, so the card
    // can never print the string "Infinity" at a player.
    rows.push({
      label: 'upgrade',
      value: nextMultiplier === null ? 'maxed' : String(upgradeCostFor(spec, level)),
    });
  }

  return rows;
}

/**
 * Where to put the panel, in pixels relative to the stage it is positioned inside.
 *
 * The panel is a DOM element over the canvas, so three coordinate spaces meet here and
 * getting any of them wrong puts the panel somewhere plausible-looking but wrong:
 *
 * - the board is measured in tiles,
 * - the canvas is drawn at a fixed backing size and then scaled to fit by CSS,
 * - the panel is positioned against the stage, which is larger than the canvas because
 *   the canvas is centred inside it with padding.
 *
 * `tilePxBacking` is a tile in *backing* pixels; multiplying by the display scale is what
 * keeps the panel beside its penguin when the window is too small to show the board at
 * full size.
 *
 * @param {object} options
 * @param {{ x: number, y: number }} options.tile
 * @param {{ width: number, height: number }} options.panel Measured panel size, CSS px.
 * @param {{ left: number, top: number, width: number, height: number }} options.canvasRect
 * @param {{ left: number, top: number }} options.stageRect
 * @param {number} options.backingWidth Canvas `width` attribute, i.e. unscaled pixels.
 * @param {number} options.tilePxBacking Backing pixels per tile.
 * @param {number} [options.gap]
 * @returns {{ x: number, y: number }} Offset from the stage's top-left, CSS px.
 */
export function panelPosition({
  tile,
  panel,
  canvasRect,
  stageRect,
  backingWidth,
  tilePxBacking,
  gap = 6,
}) {
  const displayScale = backingWidth === 0 ? 1 : canvasRect.width / backingWidth;

  const placed = cardPosition({
    tile,
    card: panel,
    tilePx: tilePxBacking * displayScale,
    board: { width: canvasRect.width, height: canvasRect.height },
    gap,
  });

  return {
    x: placed.x + (canvasRect.left - stageRect.left),
    y: placed.y + (canvasRect.top - stageRect.top),
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
