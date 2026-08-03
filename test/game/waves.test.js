import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSpawnSchedule, waveEnemyCount, waveSpawnDurationMs } from '../../src/game/waves.js';
import { TOTAL_WAVES, WAVES } from '../../src/shared/constants.js';

describe('buildSpawnSchedule', () => {
  it('emits exactly the number of enemies the table declares', () => {
    for (let wave = 1; wave <= TOTAL_WAVES; wave += 1) {
      const declared = WAVES[wave - 1].reduce((sum, g) => sum + g.count, 0);
      assert.equal(buildSpawnSchedule(wave).length, declared, `wave ${wave} count mismatch`);
    }
  });

  it('emits the right mix of types for every wave', () => {
    for (let wave = 1; wave <= TOTAL_WAVES; wave += 1) {
      /** @type {Record<string, number>} */
      const actual = {};
      for (const spawn of buildSpawnSchedule(wave)) {
        actual[spawn.type] = (actual[spawn.type] ?? 0) + 1;
      }

      /** @type {Record<string, number>} */
      const declared = {};
      for (const group of WAVES[wave - 1]) {
        declared[group.type] = (declared[group.type] ?? 0) + group.count;
      }

      assert.deepEqual(actual, declared, `wave ${wave} type mix mismatch`);
    }
  });

  it('returns spawns in ascending time order', () => {
    for (let wave = 1; wave <= TOTAL_WAVES; wave += 1) {
      const schedule = buildSpawnSchedule(wave);
      for (let i = 1; i < schedule.length; i += 1) {
        assert.ok(
          schedule[i].atMs >= schedule[i - 1].atMs,
          `wave ${wave} spawn ${i} goes backwards in time`,
        );
      }
    }
  });

  it('spaces a single group by its declared interval', () => {
    // Read from the table rather than hardcoded, because this is a test of the scheduler
    // and not of the tuning. It used to assert wave 1's literal 900ms and broke the day
    // that spacing was retuned — a balance edit should not be able to fail a test about
    // arithmetic.
    const [group] = WAVES[0];
    const schedule = buildSpawnSchedule(1);

    assert.equal(schedule[0].atMs, group.delayMs);
    assert.equal(schedule[1].atMs, group.delayMs + group.spacingMs);
    assert.equal(schedule[2].atMs, group.delayMs + group.spacingMs * 2);
  });

  it('interleaves overlapping groups by time, not by group', () => {
    // Wave 3 is walkers from 0ms and runners from 4000ms. The runners must appear in
    // the middle of the walkers, not appended after them — that interleaving is the
    // whole reason waves are expressed as overlapping groups.
    const schedule = buildSpawnSchedule(3);
    const firstRunner = schedule.findIndex((s) => s.type === 'runner');
    const lastWalker = schedule.map((s) => s.type).lastIndexOf('walker');

    assert.ok(firstRunner > 0, 'runners should not come first');
    assert.ok(firstRunner < lastWalker, 'runners must interleave with walkers');
  });

  it('is deterministic across calls', () => {
    // Ties at the same millisecond must resolve identically every run, or tests that
    // depend on spawn order become flaky.
    assert.deepEqual(buildSpawnSchedule(15), buildSpawnSchedule(15));
  });

  it('rejects wave numbers outside the defined range', () => {
    assert.throws(() => buildSpawnSchedule(0), RangeError);
    assert.throws(() => buildSpawnSchedule(TOTAL_WAVES + 1), RangeError);
    assert.throws(() => buildSpawnSchedule(1.5), RangeError);
    assert.throws(() => buildSpawnSchedule(NaN), RangeError);
  });
});

describe('waveEnemyCount', () => {
  it('agrees with the schedule it describes', () => {
    for (let wave = 1; wave <= TOTAL_WAVES; wave += 1) {
      assert.equal(waveEnemyCount(wave), buildSpawnSchedule(wave).length);
    }
  });

  it('rejects out-of-range waves', () => {
    assert.throws(() => waveEnemyCount(TOTAL_WAVES + 1), RangeError);
  });
});

describe('waveSpawnDurationMs', () => {
  it('reports the time of the final spawn', () => {
    // Derived from the table for the same reason as above: the property is "the last
    // spawn of a single group is (count - 1) intervals after its delay", not any
    // particular number of milliseconds.
    const [group] = WAVES[0];

    assert.equal(
      waveSpawnDurationMs(1),
      group.delayMs + group.spacingMs * (group.count - 1),
    );
  });

  it('is never negative', () => {
    for (let wave = 1; wave <= TOTAL_WAVES; wave += 1) {
      assert.ok(waveSpawnDurationMs(wave) >= 0);
    }
  });
});
