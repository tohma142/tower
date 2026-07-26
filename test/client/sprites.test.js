import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ENEMY_SPRITES,
  ICEBERG_SPRITE,
  PALETTE,
  PENGUIN_SPRITES,
  validateSprite,
} from '../../src/client/render/sprites.js';
import { ENEMY_TYPE_IDS, TOWER_TYPE_IDS } from '../../src/shared/constants.js';

/**
 * Every sprite in the game, with a name for failure messages.
 *
 * @type {Array<[string, ReadonlyArray<string>]>}
 */
const ALL_SPRITES = [
  ...Object.entries(PENGUIN_SPRITES).map(
    ([id, rows]) => /** @type {[string, ReadonlyArray<string>]} */ ([`penguin:${id}`, rows]),
  ),
  ...Object.entries(ENEMY_SPRITES).map(
    ([id, rows]) => /** @type {[string, ReadonlyArray<string>]} */ ([`enemy:${id}`, rows]),
  ),
  /** @type {[string, ReadonlyArray<string>]} */ (['iceberg', ICEBERG_SPRITE]),
];

describe('validateSprite', () => {
  it('accepts a well-formed sprite', () => {
    assert.deepEqual(validateSprite(['..##..', '.#..#.', '..##..']), []);
  });

  it('rejects a ragged sprite', () => {
    // A short row draws a silently clipped sprite that looks almost right, which is the
    // worst kind of wrong.
    const problems = validateSprite(['####', '##', '####']);

    assert.equal(problems.length, 1);
    assert.match(problems[0], /row 1 is 2 wide, expected 4/);
  });

  it('rejects unknown palette characters', () => {
    const problems = validateSprite(['..X..']);
    assert.match(problems[0], /unknown palette character/);
  });

  it('rejects an empty sprite', () => {
    assert.deepEqual(validateSprite([]), ['sprite has no rows']);
  });
});

describe('the shipped sprites', () => {
  for (const [name, rows] of ALL_SPRITES) {
    it(`${name} is well-formed`, () => {
      assert.deepEqual(validateSprite(rows), [], `${name} has problems`);
    });
  }

  it('covers every penguin the tuning table defines', () => {
    // A tower type with no sprite draws nothing and looks like a bug in placement.
    for (const id of TOWER_TYPE_IDS) {
      assert.ok(PENGUIN_SPRITES[id] !== undefined, `no sprite for penguin type ${id}`);
    }
  });

  it('covers every enemy the tuning table defines', () => {
    for (const id of ENEMY_TYPE_IDS) {
      assert.ok(ENEMY_SPRITES[id] !== undefined, `no sprite for enemy type ${id}`);
    }
  });

  it('draws every sprite at the same size', () => {
    const sizes = new Set(ALL_SPRITES.map(([, rows]) => `${rows[0].length}x${rows.length}`));
    assert.equal(sizes.size, 1, `sprites disagree on size: ${[...sizes].join(', ')}`);
  });

  it('keeps the palette monochrome', () => {
    // Colour is carried by shape and value, not hue. A coloured entry here would break
    // the look the whole art direction depends on.
    for (const [ch, colour] of Object.entries(PALETTE)) {
      if (colour === null) continue;
      const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour);
      assert.ok(match, `palette entry ${ch} is not a hex colour: ${colour}`);
      assert.equal(match[1], match[2], `palette entry ${ch} is not grey`);
      assert.equal(match[2], match[3], `palette entry ${ch} is not grey`);
    }
  });

  it('gives each enemy a distinct silhouette', () => {
    // They must be separable in peripheral vision while a wave is running, which they
    // cannot be if two of them are the same shape.
    const silhouettes = Object.values(ENEMY_SPRITES).map((rows) =>
      rows.map((row) => [...row].map((/** @type {string} */ ch) => (ch === '.' ? '.' : '#')).join('')).join('\n'),
    );

    assert.equal(new Set(silhouettes).size, silhouettes.length, 'two enemies share a shape');
  });

  it('leaves no sprite blank', () => {
    for (const [name, rows] of ALL_SPRITES) {
      const filled = rows.join('').split('').filter((ch) => ch !== '.').length;
      assert.ok(filled > 10, `${name} is nearly empty (${filled} pixels)`);
    }
  });
});
