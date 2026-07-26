import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findPair, lerp, pruneBuffer, sampleAt } from '../../src/client/render/interpolate.js';

/**
 * A minimal snapshot with the fields interpolation touches.
 *
 * @param {object} options
 * @param {number} options.tick
 * @param {Array<{ id: number, progress: number, hp?: number }>} [options.enemies]
 * @param {Array<{ id: number, x: number, y: number }>} [options.projectiles]
 * @param {number} [options.wave]
 * @returns {any}
 */
function snap({ tick, enemies = [], projectiles = [], wave = 1 }) {
  return {
    tick,
    phase: 'wave',
    wave,
    totalWaves: 15,
    icebergHp: 100,
    icebergMaxHp: 100,
    outcome: null,
    kills: 0,
    leaks: 0,
    waveProgress: null,
    players: [],
    enemies: enemies.map((e) => ({ id: e.id, type: 'walker', progress: e.progress, hp: e.hp ?? 1 })),
    towers: [],
    projectiles: projectiles.map((p) => ({ id: p.id, x: p.x, y: p.y, splash: false })),
  };
}

/**
 * @param {Array<[number, any]>} pairs [arrivalTime, snapshot]
 * @returns {import('../../src/client/render/interpolate.js').BufferedSnapshot[]}
 */
function buffer(pairs) {
  return pairs.map(([at, snapshot]) => ({ at, snapshot }));
}

/**
 * Assert a pair was found and hand it back narrowed.
 *
 * @param {ReturnType<typeof findPair>} pair
 * @returns {NonNullable<ReturnType<typeof findPair>>}
 */
function expectPair(pair) {
  assert.ok(pair !== null, 'expected a straddling pair');
  return pair;
}

/**
 * @param {ReturnType<typeof sampleAt>} view
 * @returns {NonNullable<ReturnType<typeof sampleAt>>}
 */
function expectView(view) {
  assert.ok(view !== null, 'expected a view to render');
  return view;
}

describe('lerp', () => {
  it('returns the endpoints exactly', () => {
    assert.equal(lerp(10, 20, 0), 10);
    assert.equal(lerp(10, 20, 1), 20);
  });

  it('interpolates linearly', () => {
    assert.equal(lerp(10, 20, 0.5), 15);
    assert.equal(lerp(-5, 5, 0.25), -2.5);
  });
});

describe('findPair', () => {
  it('returns null for an empty buffer', () => {
    assert.equal(findPair([], 100), null);
  });

  it('holds on the only snapshot it has', () => {
    const buf = buffer([[100, snap({ tick: 1 })]]);
    const pair = expectPair(findPair(buf, 500));

    assert.equal(pair.from, pair.to);
    assert.equal(pair.t, 0);
  });

  it('finds the straddling pair and the fraction between them', () => {
    const buf = buffer([[0, snap({ tick: 1 })], [50, snap({ tick: 2 })], [100, snap({ tick: 3 })]]);
    const pair = expectPair(findPair(buf, 75));

    assert.equal(pair.from.snapshot.tick, 2);
    assert.equal(pair.to.snapshot.tick, 3);
    assert.equal(pair.t, 0.5);
  });

  it('shows the oldest rather than extrapolating backwards', () => {
    const buf = buffer([[100, snap({ tick: 1 })], [150, snap({ tick: 2 })]]);
    const pair = expectPair(findPair(buf, 10));

    assert.equal(pair.from.snapshot.tick, 1);
    assert.equal(pair.t, 0);
  });

  it('holds on the newest rather than extrapolating forwards', () => {
    // Guessing ahead makes enemies overshoot and snap back when the next packet lands,
    // which reads far worse than a brief pause.
    const buf = buffer([[0, snap({ tick: 1 })], [50, snap({ tick: 2 })]]);
    const pair = expectPair(findPair(buf, 5000));

    assert.equal(pair.from.snapshot.tick, 2);
    assert.equal(pair.to.snapshot.tick, 2);
    assert.equal(pair.t, 0);
  });

  it('does not divide by zero when two snapshots share a timestamp', () => {
    const buf = buffer([[100, snap({ tick: 1 })], [100, snap({ tick: 2 })]]);
    const pair = expectPair(findPair(buf, 100));

    assert.ok(Number.isFinite(pair.t));
  });
});

describe('sampleAt', () => {
  it('returns null with nothing buffered', () => {
    assert.equal(sampleAt([], 0), null);
  });

  it('interpolates enemy progress between snapshots', () => {
    // The whole reason this module exists: a 20 Hz simulation drawn at 60 Hz.
    const buf = buffer([
      [0, snap({ tick: 1, enemies: [{ id: 7, progress: 10 }] })],
      [50, snap({ tick: 2, enemies: [{ id: 7, progress: 20 }] })],
    ]);

    const view = expectView(sampleAt(buf, 25));

    assert.equal(view.enemies[0].progress, 15);
  });

  it('interpolates projectile positions', () => {
    const buf = buffer([
      [0, snap({ tick: 1, projectiles: [{ id: 3, x: 0, y: 0 }] })],
      [50, snap({ tick: 2, projectiles: [{ id: 3, x: 4, y: 8 }] })],
    ]);

    const view = expectView(sampleAt(buf, 25));

    assert.equal(view.projectiles[0].x, 2);
    assert.equal(view.projectiles[0].y, 4);
  });

  it('matches entities by id, not by array position', () => {
    // Enemies die mid-wave, so index N in one snapshot is rarely index N in the next.
    // Pairing by position would make survivors visibly teleport.
    const buf = buffer([
      [0, snap({ tick: 1, enemies: [{ id: 1, progress: 5 }, { id: 2, progress: 30 }] })],
      [50, snap({ tick: 2, enemies: [{ id: 2, progress: 34 }] })],
    ]);

    const view = expectView(sampleAt(buf, 25));
    const second = view.enemies.find((e) => e.id === 2);
    assert.ok(second !== undefined, 'enemy 2 should survive');

    assert.equal(second.progress, 32, 'enemy 2 should advance by half of its own delta');
  });

  it('leaves an enemy that vanished where it was rather than guessing', () => {
    const buf = buffer([
      [0, snap({ tick: 1, enemies: [{ id: 1, progress: 5 }] })],
      [50, snap({ tick: 2, enemies: [] })],
    ]);

    const view = expectView(sampleAt(buf, 25));

    assert.equal(view.enemies[0].progress, 5);
  });

  it('interpolates health so a damage bar slides rather than jumps', () => {
    const buf = buffer([
      [0, snap({ tick: 1, enemies: [{ id: 1, progress: 0, hp: 1 }] })],
      [50, snap({ tick: 2, enemies: [{ id: 1, progress: 0, hp: 0.5 }] })],
    ]);

    assert.equal(expectView(sampleAt(buf, 25)).enemies[0].hp, 0.75);
  });

  it('takes discrete state from the earlier snapshot', () => {
    // Otherwise the wave counter ticks over while the previous wave's last enemy is
    // still being rendered.
    const buf = buffer([
      [0, snap({ tick: 1, wave: 3 })],
      [50, snap({ tick: 2, wave: 4 })],
    ]);

    assert.equal(expectView(sampleAt(buf, 49)).wave, 3);
  });

  it('marks its output so nothing mistakes it for a raw snapshot', () => {
    const buf = buffer([[0, snap({ tick: 1 })]]);
    assert.equal(expectView(sampleAt(buf, 0)).interpolated, true);
  });

  it('does not mutate the buffered snapshots', () => {
    const original = snap({ tick: 1, enemies: [{ id: 1, progress: 10 }] });
    const buf = buffer([[0, original], [50, snap({ tick: 2, enemies: [{ id: 1, progress: 20 }] })]]);

    sampleAt(buf, 25);

    assert.equal(original.enemies[0].progress, 10, 'the buffer must stay reusable');
  });
});

describe('pruneBuffer', () => {
  it('drops snapshots older than the window', () => {
    const buf = buffer([
      [0, snap({ tick: 1 })],
      [100, snap({ tick: 2 })],
      [200, snap({ tick: 3 })],
      [300, snap({ tick: 4 })],
    ]);

    pruneBuffer(buf, 350, 150);

    assert.ok(buf.length < 4, 'something should have been dropped');
    assert.equal(buf[buf.length - 1].snapshot.tick, 4, 'the newest is always kept');
  });

  it('keeps one entry older than the cutoff to interpolate out of', () => {
    // Dropping it would leave the renderer with nothing on the left-hand side and the
    // world would snap instead of gliding.
    const buf = buffer([
      [0, snap({ tick: 1 })],
      [100, snap({ tick: 2 })],
      [200, snap({ tick: 3 })],
    ]);

    pruneBuffer(buf, 250, 100);

    assert.ok(buf.some((entry) => 250 - entry.at > 100), 'an older anchor must survive');
  });

  it('keeps a buffer bounded over a long session', () => {
    // At 20 snapshots a second an unbounded buffer is a slow memory leak.
    /** @type {any[]} */
    const buf = [];
    for (let i = 0; i < 2000; i += 1) {
      buf.push({ at: i * 50, snapshot: snap({ tick: i }) });
      pruneBuffer(buf, i * 50, 600);
    }

    assert.ok(buf.length < 30, `buffer grew to ${buf.length}`);
  });

  it('never empties the buffer', () => {
    const buf = buffer([[0, snap({ tick: 1 })]]);
    pruneBuffer(buf, 1_000_000, 10);

    assert.equal(buf.length, 1, 'the renderer must always have something to draw');
  });
});
