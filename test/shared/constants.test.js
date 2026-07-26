import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ENEMY_TYPES,
  ENEMY_TYPE_IDS,
  MAX_PLAYERS,
  TICK_HZ,
  TICK_MS,
  TOTAL_WAVES,
  TOWER_TYPES,
  TOWER_TYPE_IDS,
  RENDER_DELAY_MS,
  WAVES,
  hpScaleFor,
} from '../../src/shared/constants.js';

describe('tuning tables', () => {
  it('defines exactly TOTAL_WAVES waves', () => {
    assert.equal(WAVES.length, TOTAL_WAVES);
  });

  it('only references enemy types that exist', () => {
    // A typo here would otherwise surface as an undefined enemy mid-game, on whichever
    // wave contains it — possibly wave 13, minutes into a session.
    for (const [index, wave] of WAVES.entries()) {
      for (const group of wave) {
        assert.ok(
          ENEMY_TYPE_IDS.includes(group.type),
          `wave ${index + 1} references unknown enemy type "${group.type}"`,
        );
      }
    }
  });

  it('gives every spawn group a sane count, spacing, and delay', () => {
    for (const [index, wave] of WAVES.entries()) {
      assert.ok(wave.length > 0, `wave ${index + 1} is empty`);
      for (const group of wave) {
        assert.ok(Number.isInteger(group.count) && group.count > 0, `wave ${index + 1} bad count`);
        assert.ok(group.spacingMs >= 0, `wave ${index + 1} negative spacing`);
        assert.ok(group.delayMs >= 0, `wave ${index + 1} negative delay`);
      }
    }
  });

  it('gets harder over the course of the game', () => {
    // Total enemy hit points per wave, as a crude difficulty proxy. Waves may plateau,
    // but wave 15 must be meaningfully harder than wave 1 or the ramp is broken.
    /**
     * @param {ReadonlyArray<import('../../src/shared/constants.js').SpawnGroup>} wave
     * @returns {number}
     */
    const weight = (wave) =>
      wave.reduce((sum, g) => sum + g.count * ENEMY_TYPES[g.type].hp, 0);

    assert.ok(weight(WAVES[14]) > weight(WAVES[0]) * 10, 'wave 15 should dwarf wave 1');
    assert.ok(weight(WAVES[7]) > weight(WAVES[0]), 'mid game should exceed the opener');
  });

  it('describes every tower with positive, usable stats', () => {
    for (const id of TOWER_TYPE_IDS) {
      const tower = TOWER_TYPES[id];
      assert.equal(tower.id, id, 'tower id must match its table key');
      assert.ok(tower.cost > 0, `${id} must cost something`);
      assert.ok(tower.range > 0, `${id} must have range`);
      assert.ok(tower.damage > 0, `${id} must do damage`);
      assert.ok(tower.fireRate > 0, `${id} must fire`);
      assert.ok(tower.projectileSpeed > 0, `${id} projectiles must move`);
      assert.ok(tower.splashRadius >= 0, `${id} splash cannot be negative`);
    }
  });

  it('describes every enemy with positive, usable stats', () => {
    for (const id of ENEMY_TYPE_IDS) {
      const enemy = ENEMY_TYPES[id];
      assert.equal(enemy.id, id, 'enemy id must match its table key');
      assert.ok(enemy.hp > 0, `${id} must have hit points`);
      assert.ok(enemy.speed > 0, `${id} must move`);
      assert.ok(enemy.damage > 0, `${id} must threaten the iceberg`);
      assert.ok(enemy.bounty > 0, `${id} must pay out`);
    }
  });

  it('freezes the tables so a stray write cannot retune the game at runtime', () => {
    assert.ok(Object.isFrozen(TOWER_TYPES));
    assert.ok(Object.isFrozen(ENEMY_TYPES));
    assert.ok(Object.isFrozen(WAVES));
    assert.ok(Object.isFrozen(TOWER_TYPES.pistol));
  });
});

describe('hpScaleFor', () => {
  it('leaves a solo game unscaled', () => {
    assert.equal(hpScaleFor(1), 1);
  });

  it('scales up with headcount, because income is shared', () => {
    assert.equal(hpScaleFor(2), 1.6);
    assert.ok(Math.abs(hpScaleFor(3) - 2.2) < 1e-9);
    assert.ok(Math.abs(hpScaleFor(MAX_PLAYERS) - 2.8) < 1e-9);
  });

  it('is monotonic across the supported range', () => {
    for (let n = 1; n < MAX_PLAYERS; n += 1) {
      assert.ok(hpScaleFor(n + 1) > hpScaleFor(n), `scale must rise from ${n} to ${n + 1}`);
    }
  });

  it('treats zero or negative headcount as solo rather than shrinking enemies', () => {
    // A room can briefly report zero connected players mid-transition; that must not
    // hand the survivors a game with zero-hit-point enemies.
    assert.equal(hpScaleFor(0), 1);
    assert.equal(hpScaleFor(-5), 1);
  });
});

describe('simulation cadence', () => {
  it('derives TICK_MS from TICK_HZ', () => {
    assert.equal(TICK_MS, 1000 / TICK_HZ);
    assert.equal(TICK_MS, 50);
  });

  it('leaves the client more than one tick of interpolation buffer', () => {
    // With a delay at or below one tick, a single late packet leaves the renderer with
    // nothing to interpolate towards and the world visibly freezes.
    assert.ok(RENDER_DELAY_MS > TICK_MS, 'render delay must exceed one tick');
  });
});
