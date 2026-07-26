import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  advanceEnemies,
  damageEnemy,
  findTarget,
  removeDeadEnemies,
  spawnEnemy,
} from '../../src/game/enemies.js';
import { ENEMY_TYPES, ICEBERG_HP, TICK_MS, hpScaleFor } from '../../src/shared/constants.js';
import { PATH_LENGTH, positionAt } from '../../src/shared/map.js';
import { makeGame, player } from '../helpers/game.js';

describe('spawnEnemy', () => {
  it('places the enemy at the start of the path with full hit points', () => {
    const state = makeGame();
    const enemy = spawnEnemy(state, 'walker');

    assert.equal(enemy.progress, 0);
    assert.equal(enemy.hp, enemy.maxHp);
    assert.equal(enemy.hp, ENEMY_TYPES.walker.hp, 'solo game applies no scaling');
    assert.deepEqual(state.enemies, [enemy]);
  });

  it('gives every enemy a distinct id', () => {
    const state = makeGame();
    const ids = new Set([
      spawnEnemy(state, 'walker').id,
      spawnEnemy(state, 'walker').id,
      spawnEnemy(state, 'runner').id,
    ]);
    assert.equal(ids.size, 3);
  });

  it('scales hit points by headcount at spawn time', () => {
    // Four players each earn the full bounty, so they field roughly four times the
    // firepower; enemies must scale or the late waves are a walkover.
    const state = makeGame({ players: ['a', 'b', 'c', 'd'] });
    const enemy = spawnEnemy(state, 'brute');

    assert.equal(state.hpScale, hpScaleFor(4));
    assert.equal(enemy.maxHp, ENEMY_TYPES.brute.hp * hpScaleFor(4));
  });

  it('does not retune enemies already on the board when the scale changes', () => {
    // A mid-game join must not alter a wave that is already walking.
    const state = makeGame({ players: ['a'] });
    const early = spawnEnemy(state, 'walker');

    state.hpScale = 3;
    const late = spawnEnemy(state, 'walker');

    assert.equal(early.maxHp, ENEMY_TYPES.walker.hp);
    assert.equal(late.maxHp, ENEMY_TYPES.walker.hp * 3);
  });

  it('throws on an unknown type rather than producing a NaN enemy', () => {
    const state = makeGame();
    assert.throws(() => spawnEnemy(state, 'dragon'), TypeError);
  });
});

describe('advanceEnemies', () => {
  it('moves an enemy at exactly its declared speed', () => {
    const state = makeGame();
    const enemy = spawnEnemy(state, 'walker');

    advanceEnemies(state, 1000);

    assert.ok(
      Math.abs(enemy.progress - ENEMY_TYPES.walker.speed) < 1e-9,
      'one second of travel must equal one second of declared speed',
    );
  });

  it('moves faster enemies further in the same time', () => {
    const state = makeGame();
    const walker = spawnEnemy(state, 'walker');
    const runner = spawnEnemy(state, 'runner');

    advanceEnemies(state, 1000);

    assert.ok(runner.progress > walker.progress);
  });

  it('subtracts exactly the enemy damage when it reaches the iceberg', () => {
    const state = makeGame();
    const enemy = spawnEnemy(state, 'walker');
    enemy.progress = PATH_LENGTH - 0.001;

    advanceEnemies(state, TICK_MS);

    assert.equal(state.icebergHp, ICEBERG_HP - ENEMY_TYPES.walker.damage);
    assert.equal(state.leaks, 1);
  });

  it('makes a leaked brute cost far more than a leaked runner', () => {
    // The reason the objective is a health pool rather than a lives counter.
    const bruteState = makeGame();
    const brute = spawnEnemy(bruteState, 'brute');
    brute.progress = PATH_LENGTH;
    advanceEnemies(bruteState, TICK_MS);

    const runnerState = makeGame();
    const runner = spawnEnemy(runnerState, 'runner');
    runner.progress = PATH_LENGTH;
    advanceEnemies(runnerState, TICK_MS);

    const bruteCost = ICEBERG_HP - bruteState.icebergHp;
    const runnerCost = ICEBERG_HP - runnerState.icebergHp;
    assert.ok(bruteCost > runnerCost * 5, `brute ${bruteCost} should dwarf runner ${runnerCost}`);
  });

  it('pays no bounty for an enemy that leaked', () => {
    // Leaking must never be a way to farm fish.
    const state = makeGame();
    const before = player(state, 'p1').fish;
    const enemy = spawnEnemy(state, 'walker');
    enemy.progress = PATH_LENGTH;

    advanceEnemies(state, TICK_MS);
    removeDeadEnemies(state);

    assert.equal(player(state, 'p1').fish, before);
    assert.equal(state.kills, 0);
  });

  it('never drives the iceberg below zero', () => {
    const state = makeGame();
    state.icebergHp = 3;
    const enemy = spawnEnemy(state, 'brute');
    enemy.progress = PATH_LENGTH;

    advanceEnemies(state, TICK_MS);

    assert.equal(state.icebergHp, 0);
  });

  it('emits one leak event carrying the damage and remaining hit points', () => {
    const state = makeGame();
    state.events = [];
    const enemy = spawnEnemy(state, 'brute');
    enemy.progress = PATH_LENGTH;

    advanceEnemies(state, TICK_MS);

    const leaks = state.events.filter((e) => e.kind === 'leak');
    assert.equal(leaks.length, 1);
    assert.equal(leaks[0].damage, ENEMY_TYPES.brute.damage);
    assert.equal(leaks[0].icebergHp, state.icebergHp);
  });

  it('leaves already-dead enemies alone', () => {
    const state = makeGame();
    const enemy = spawnEnemy(state, 'walker');
    enemy.hp = 0;

    advanceEnemies(state, 1000);

    assert.equal(enemy.progress, 0, 'a corpse must not keep walking');
    assert.equal(state.icebergHp, ICEBERG_HP);
  });
});

describe('damageEnemy', () => {
  it('pays every player when it kills', () => {
    const state = makeGame({ players: ['a', 'b'] });
    const before = [...state.players.values()].map((p) => p.fish);
    const enemy = spawnEnemy(state, 'walker');

    const killed = damageEnemy(state, enemy, enemy.hp);

    assert.equal(killed, true);
    assert.equal(state.kills, 1);
    for (const [i, p] of [...state.players.values()].entries()) {
      assert.equal(p.fish, before[i] + ENEMY_TYPES.walker.bounty);
    }
  });

  it('pays nothing for a non-fatal hit', () => {
    const state = makeGame();
    const before = player(state, 'p1').fish;
    const enemy = spawnEnemy(state, 'brute');

    assert.equal(damageEnemy(state, enemy, 1), false);
    assert.equal(player(state, 'p1').fish, before);
  });

  it('pays exactly one bounty when overkilled', () => {
    const state = makeGame();
    const before = player(state, 'p1').fish;
    const enemy = spawnEnemy(state, 'walker');

    damageEnemy(state, enemy, 9999);

    assert.equal(player(state, 'p1').fish, before + ENEMY_TYPES.walker.bounty);
    assert.equal(enemy.hp, 0, 'hit points must clamp rather than go negative');
  });

  it('cannot be paid twice for the same enemy', () => {
    // Splash damage can hit a corpse in the same tick it died; that must not double-pay.
    const state = makeGame();
    const before = player(state, 'p1').fish;
    const enemy = spawnEnemy(state, 'walker');

    damageEnemy(state, enemy, 9999);
    const second = damageEnemy(state, enemy, 9999);

    assert.equal(second, false);
    assert.equal(player(state, 'p1').fish, before + ENEMY_TYPES.walker.bounty);
    assert.equal(state.kills, 1);
  });
});

describe('removeDeadEnemies', () => {
  it('drops the dead and keeps the living, preserving order', () => {
    const state = makeGame();
    const a = spawnEnemy(state, 'walker');
    const b = spawnEnemy(state, 'walker');
    const c = spawnEnemy(state, 'walker');
    b.hp = 0;

    removeDeadEnemies(state);

    assert.deepEqual(state.enemies.map((e) => e.id), [a.id, c.id]);
  });

  it('handles several deaths in one tick', () => {
    const state = makeGame();
    const kept = spawnEnemy(state, 'walker');
    for (let i = 0; i < 5; i += 1) spawnEnemy(state, 'walker').hp = 0;

    removeDeadEnemies(state);

    assert.deepEqual(state.enemies, [kept]);
  });
});

describe('findTarget', () => {
  it('picks the enemy furthest along the path, not the nearest', () => {
    // The standard tower-defense rule: shoot what you are about to lose to.
    const state = makeGame();
    const behind = spawnEnemy(state, 'walker');
    const ahead = spawnEnemy(state, 'walker');
    behind.progress = 1;
    ahead.progress = 4;

    const origin = positionAt(2.5);
    const target = findTarget(state.enemies, origin, 100 * 100);

    assert.ok(target !== null, 'expected a target to be acquired');

    assert.equal(target.id, ahead.id);
  });

  it('ignores enemies outside range', () => {
    const state = makeGame();
    const near = spawnEnemy(state, 'walker');
    const far = spawnEnemy(state, 'walker');
    near.progress = 1;
    far.progress = 30;

    const origin = positionAt(1);
    const target = findTarget(state.enemies, origin, 2 * 2);

    assert.ok(target !== null, 'expected a target to be acquired');

    assert.equal(target.id, near.id, 'the further-along enemy is out of range');
  });

  it('returns null when nothing is in range', () => {
    const state = makeGame();
    spawnEnemy(state, 'walker').progress = 30;

    assert.equal(findTarget(state.enemies, positionAt(0), 1), null);
  });

  it('returns null for an empty board', () => {
    assert.equal(findTarget([], { x: 0, y: 0 }, 100), null);
  });

  it('never targets a dead enemy', () => {
    const state = makeGame();
    const corpse = spawnEnemy(state, 'walker');
    const alive = spawnEnemy(state, 'walker');
    corpse.progress = 10;
    corpse.hp = 0;
    alive.progress = 2;

    const target = findTarget(state.enemies, positionAt(5), 100 * 100);

    assert.ok(target !== null, 'expected a target to be acquired');

    assert.equal(target.id, alive.id);
  });

  it('treats range as inclusive at its exact boundary', () => {
    const state = makeGame();
    const enemy = spawnEnemy(state, 'walker');
    enemy.progress = 3;

    const origin = positionAt(0);
    const pos = positionAt(3);
    const exact = (pos.x - origin.x) ** 2 + (pos.y - origin.y) ** 2;

    assert.notEqual(findTarget(state.enemies, origin, exact), null, 'boundary must count as in range');
  });
});
