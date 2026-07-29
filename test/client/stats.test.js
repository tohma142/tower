/**
 * The unit stat card — what it says and where it goes.
 *
 * The card sits on top of the board, so the two things worth pinning down are that it
 * reports the unit's *current* numbers rather than its table numbers, and that it never
 * ends up somewhere a player cannot read it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cardPosition,
  cardSize,
  cardTitle,
  formatStat,
  statLines,
} from '../../src/client/render/stats.js';
import {
  MAX_TOWER_LEVEL,
  TOWER_TYPES,
  TOWER_TYPE_IDS,
  isCombatTower,
  levelMultiplier,
} from '../../src/shared/constants.js';

/** A card big enough to exercise the flipping, in a board 20x12 tiles at 48px. */
const TILE_PX = 48;
const BOARD = { width: 20 * TILE_PX, height: 12 * TILE_PX };
const CARD = { width: 160, height: 90 };

describe('statLines', () => {
  it('reports what a combat unit does to enemies', () => {
    const rows = statLines(TOWER_TYPES.sniper, 1);
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));

    assert.equal(byLabel.dmg, '12');
    assert.equal(byLabel.rng, '7');
    assert.equal(byLabel.rate, '0.5/s');
  });

  it('reports the current level, not the table value', () => {
    // The whole point of the card. Showing 12 while the penguin hits for 21 would be
    // worse than showing nothing.
    const base = statLines(TOWER_TYPES.sniper, 1).find((r) => r.label === 'dmg');
    const upgraded = statLines(TOWER_TYPES.sniper, 2).find((r) => r.label === 'dmg');

    assert.equal(base?.value, '12');
    assert.equal(upgraded?.value, String(12 * levelMultiplier(2)));
    assert.notEqual(base?.value, upgraded?.value);
  });

  it('reports a support unit by what it pays, not by its damage', () => {
    // Listing `dmg 0` for a Fisher is technically true and actively misleading: it reads
    // as a broken gun rather than as a unit that has no gun.
    const rows = statLines(TOWER_TYPES.fisher, 1);

    assert.deepEqual(rows.map((r) => r.label), ['fish/wave']);
    assert.equal(rows[0].value, String(TOWER_TYPES.fisher.income));
  });

  it('scales a support unit\'s payout with level too', () => {
    const rows = statLines(TOWER_TYPES.fisher, MAX_TOWER_LEVEL);

    assert.equal(
      rows[0].value,
      String(TOWER_TYPES.fisher.income * levelMultiplier(MAX_TOWER_LEVEL)),
    );
  });

  it('shows splash only on units that have it', () => {
    // A row that never changes and never matters still costs height on a card sitting
    // over the board.
    const bomber = statLines(TOWER_TYPES.bomber, 1).map((r) => r.label);
    const pistol = statLines(TOWER_TYPES.pistol, 1).map((r) => r.label);

    assert.ok(bomber.includes('splash'));
    assert.equal(pistol.includes('splash'), false);
  });

  it('produces readable rows for every unit at every level', () => {
    // Driven off the tables, so a unit or level added later is covered without anyone
    // remembering to extend this file.
    for (const id of TOWER_TYPE_IDS) {
      for (let level = 1; level <= MAX_TOWER_LEVEL; level += 1) {
        const rows = statLines(TOWER_TYPES[id], level);

        assert.ok(rows.length > 0, `${id} L${level} reported nothing`);
        for (const { label, value } of rows) {
          assert.ok(label.length > 0, `${id} L${level} has an unlabelled row`);
          assert.ok(value.length > 0, `${id} L${level} ${label} has no value`);
          assert.equal(value.includes('NaN'), false, `${id} L${level} ${label} is NaN`);
          assert.equal(value.includes('undefined'), false, `${id} L${level} ${label}`);
        }
      }
    }
  });

  it('never reports a combat unit as dealing nothing', () => {
    for (const id of TOWER_TYPE_IDS) {
      const spec = TOWER_TYPES[id];
      if (!isCombatTower(spec)) continue;

      const dmg = statLines(spec, 1).find((r) => r.label === 'dmg');
      assert.ok(dmg !== undefined && dmg.value !== '0', `${id} reported 0 damage`);
    }
  });
});

describe('formatStat', () => {
  it('keeps whole numbers whole', () => {
    assert.equal(formatStat(12), '12');
    assert.equal(formatStat(0.5), '0.5');
  });

  it('trims the noise off a level multiplier', () => {
    // 6 x 1.75 is 10.5, not 10.500000000000002 — but nor should it round to 11 and
    // misreport a real difference.
    assert.equal(formatStat(6 * 1.75), '10.5');
    assert.equal(formatStat(2 * 1.75), '3.5');
  });

  it('drops a trailing zero rather than showing 21.0', () => {
    assert.equal(formatStat(12 * 1.75), '21');
  });
});

describe('cardTitle', () => {
  it('names the unit in caps with its level', () => {
    assert.equal(cardTitle(TOWER_TYPES.sniper, 2), 'SNIPER  L2');
  });
});

describe('cardSize', () => {
  it('is wide enough for its widest row', () => {
    const metrics = { charWidth: 10, lineHeight: 16, padding: 5 };
    const narrow = cardSize({ title: 'A', lines: [{ label: 'x', value: '1' }] }, metrics);
    const wide = cardSize(
      { title: 'A', lines: [{ label: 'splashiest', value: '10.5' }] },
      metrics,
    );

    assert.ok(wide.width > narrow.width);
  });

  it('is wide enough for a title longer than any row', () => {
    const metrics = { charWidth: 10, lineHeight: 16, padding: 5 };
    const size = cardSize({ title: 'A VERY LONG NAME  L3', lines: [] }, metrics);

    assert.ok(size.columns >= 'A VERY LONG NAME  L3'.length);
  });

  it('grows a line at a time', () => {
    const metrics = { charWidth: 10, lineHeight: 16, padding: 5 };
    const one = cardSize({ title: 'T', lines: [{ label: 'a', value: '1' }] }, metrics);
    const two = cardSize(
      { title: 'T', lines: [{ label: 'a', value: '1' }, { label: 'b', value: '2' }] },
      metrics,
    );

    assert.equal(two.height - one.height, metrics.lineHeight);
  });
});

describe('cardPosition', () => {
  it('sits above and right of the tile, clear of the penguin', () => {
    const pos = cardPosition({
      tile: { x: 5, y: 5 },
      card: CARD,
      tilePx: TILE_PX,
      board: BOARD,
    });

    assert.ok(pos.x > 5 * TILE_PX, 'should be to the right');
    assert.ok(pos.y + CARD.height < 5 * TILE_PX, 'should be above');
    assert.equal(pos.flippedX, false);
    assert.equal(pos.flippedY, false);
  });

  it('flips to the left rather than running off the right edge', () => {
    // The iceberg is on the right, which is exactly where a clamped card would cover the
    // part of the board that matters most.
    const pos = cardPosition({
      tile: { x: 19, y: 5 },
      card: CARD,
      tilePx: TILE_PX,
      board: BOARD,
    });

    assert.equal(pos.flippedX, true);
    assert.ok(pos.x + CARD.width <= 19 * TILE_PX, 'must not cover its own tile');
  });

  it('flips below rather than running off the top', () => {
    const pos = cardPosition({
      tile: { x: 5, y: 0 },
      card: CARD,
      tilePx: TILE_PX,
      board: BOARD,
    });

    assert.equal(pos.flippedY, true);
    assert.ok(pos.y >= TILE_PX, 'must sit below the tile it describes');
  });

  it('stays on the board from every tile on it', () => {
    // The property that matters, asserted exhaustively rather than at a few corners.
    for (let x = 0; x < 20; x += 1) {
      for (let y = 0; y < 12; y += 1) {
        const pos = cardPosition({
          tile: { x, y },
          card: CARD,
          tilePx: TILE_PX,
          board: BOARD,
        });

        assert.ok(pos.x >= 0, `(${x},${y}) ran off the left`);
        assert.ok(pos.y >= 0, `(${x},${y}) ran off the top`);
        assert.ok(pos.x + CARD.width <= BOARD.width, `(${x},${y}) ran off the right`);
        assert.ok(pos.y + CARD.height <= BOARD.height, `(${x},${y}) ran off the bottom`);
      }
    }
  });

  it('clamps rather than vanishing when the card cannot fit at all', () => {
    // A board smaller than the card is not a real configuration, but drawing off-canvas
    // is a silent failure and clamping is a visible one.
    const huge = { width: 5000, height: 5000 };
    const pos = cardPosition({
      tile: { x: 1, y: 1 },
      card: huge,
      tilePx: TILE_PX,
      board: BOARD,
    });

    assert.equal(pos.x, 0);
    assert.equal(pos.y, 0);
  });
});
