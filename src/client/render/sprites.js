/**
 * Pixel art, defined in code.
 *
 * Every sprite is a small array of strings — one character per pixel — compiled once
 * into an offscreen canvas at load. There are no image files anywhere in the repo, so
 * sprites are diffable in git, a palette change is one constant, and there is no asset
 * pipeline to maintain.
 *
 * The palette is deliberately monochrome: black, white, and three greys. Colour is
 * carried entirely by shape and value, which is why the enemies read as distinct
 * silhouettes rather than as recoloured copies of each other.
 */

/**
 * Character to palette entry.
 *
 * `.` is transparent. The rest run dark to light, so a sprite reads as a value sketch
 * in source: the string art looks roughly like the thing it draws.
 */
/** @type {Readonly<Record<string, string | null>>} */
export const PALETTE = Object.freeze({
  '.': null,
  '#': '#0a0a0a',
  '+': '#4a4a4a',
  '-': '#8a8a8a',
  '*': '#c8c8c8',
  'o': '#f2f2f2',
});

/**
 * Penguins. Stick figures, upright, with a visible weapon so the three read apart at a
 * glance — which matters more than detail at 16 pixels.
 */
/** @type {Readonly<Record<string, ReadonlyArray<string>>>} */
export const PENGUIN_SPRITES = Object.freeze({
  // Pistol: compact, one arm out.
  pistol: Object.freeze([
    '....####....',
    '...#oooo#...',
    '...#o##o#...',
    '...#oooo#...',
    '....#--#....',
    '...######...',
    '..#o####o#..',
    '..#o####o#+.',
    '..#o####o##.',
    '...######...',
    '...##..##...',
    '..###..###..',
  ]),
  // Sniper: taller stance, long barrel across the body.
  sniper: Object.freeze([
    '....####....',
    '...#oooo#...',
    '...#o##o#...',
    '...#oooo#...',
    '....#--#....',
    '.+######....',
    '.+#o####o#..',
    '++#o####o#..',
    '.+#o####o#..',
    '...######...',
    '...##..##...',
    '..###..###..',
  ]),
  // Bomber: wider body, round charge held low.
  bomber: Object.freeze([
    '....####....',
    '...#oooo#...',
    '...#o##o#...',
    '...#oooo#...',
    '....#--#....',
    '..########..',
    '.#o######o#.',
    '.#o######o#.',
    '.#o######o#.',
    '..########..',
    '..##+##+##..',
    '.###.###.##.',
  ]),
});

/**
 * Enemies. Each is a distinct silhouette — squat, lean, and bulky — so they are
 * separable in peripheral vision while a wave is running.
 */
/** @type {Readonly<Record<string, ReadonlyArray<string>>>} */
export const ENEMY_SPRITES = Object.freeze({
  // Walrus: low and heavy, tusks down.
  walker: Object.freeze([
    '............',
    '...######...',
    '..#--++--#..',
    '.#--#--#--#.',
    '.#--------#.',
    '.#-#----#-#.',
    '.#--------#.',
    '..#-#--#-#..',
    '...#....#...',
    '..##....##..',
    '............',
    '............',
  ]),
  // Arctic fox: lean, forward-leaning, long tail.
  runner: Object.freeze([
    '............',
    '.......##...',
    '......#**#..',
    '.....#****#.',
    '..#########.',
    '.#*********#',
    '#**#*****#*#',
    '.#*********#',
    '..#*#***#*#.',
    '...#.....#..',
    '............',
    '............',
  ]),
  // Polar bear: fills the tile, deliberately reads as a wall.
  brute: Object.freeze([
    '..########..',
    '.#oooooooo#.',
    '#oo#oooo#oo#',
    '#oooooooooo#',
    '#oo#oooo#oo#',
    '#ooo####ooo#',
    '#oooooooooo#',
    '#oooooooooo#',
    '#oo#oooo#oo#',
    '.#oo####oo#.',
    '.##......##.',
    '###......###',
  ]),
});

/** The iceberg being defended. */
export const ICEBERG_SPRITE = Object.freeze([
  '.....##.....',
  '....#oo#....',
  '...#oooo#...',
  '..#oo**oo#..',
  '.#oo****oo#.',
  '#oo******oo#',
  '#o********o#',
  '#**********#',
  '#**--**--**#',
  '#--++--++--#',
  '.#--------#.',
  '..########..',
]);

/**
 * Compile a string-art sprite into a canvas ready to blit.
 *
 * Drawn once at native size and scaled with smoothing off, so pixels stay square
 * instead of turning to mush.
 *
 * @param {ReadonlyArray<string>} rows
 * @param {number} scale Integer upscale factor.
 * @returns {HTMLCanvasElement}
 */
export function compileSprite(rows, scale) {
  const height = rows.length;
  const width = height === 0 ? 0 : rows[0].length;

  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;

  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2d canvas context unavailable');
  ctx.imageSmoothingEnabled = false;

  for (let y = 0; y < height; y += 1) {
    const row = rows[y];
    for (let x = 0; x < row.length; x += 1) {
      const colour = PALETTE[row[x]];
      if (colour == null) continue;
      ctx.fillStyle = colour;
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }

  return canvas;
}

/**
 * Check that a sprite is rectangular and uses only known palette characters.
 *
 * Pure, and separated from compilation so it can be tested without a canvas. A ragged
 * row would otherwise draw a silently clipped sprite that looks almost right.
 *
 * @param {ReadonlyArray<string>} rows
 * @returns {string[]} Problems found; empty means the sprite is well-formed.
 */
export function validateSprite(rows) {
  /** @type {string[]} */
  const problems = [];

  if (rows.length === 0) {
    problems.push('sprite has no rows');
    return problems;
  }

  const width = rows[0].length;
  for (const [y, row] of rows.entries()) {
    if (row.length !== width) {
      problems.push(`row ${y} is ${row.length} wide, expected ${width}`);
    }
    for (const ch of row) {
      if (!Object.prototype.hasOwnProperty.call(PALETTE, ch)) {
        problems.push(`row ${y} uses unknown palette character: ${JSON.stringify(ch)}`);
      }
    }
  }

  return problems;
}

/**
 * Compile every sprite once.
 *
 * @param {number} scale
 * @returns {{ penguins: Record<string, HTMLCanvasElement>, enemies: Record<string, HTMLCanvasElement>, iceberg: HTMLCanvasElement }}
 */
export function compileAll(scale) {
  /** @type {Record<string, HTMLCanvasElement>} */
  const penguins = {};
  for (const [id, rows] of Object.entries(PENGUIN_SPRITES)) {
    penguins[id] = compileSprite(rows, scale);
  }

  /** @type {Record<string, HTMLCanvasElement>} */
  const enemies = {};
  for (const [id, rows] of Object.entries(ENEMY_SPRITES)) {
    enemies[id] = compileSprite(rows, scale);
  }

  return { penguins, enemies, iceberg: compileSprite(ICEBERG_SPRITE, scale) };
}
