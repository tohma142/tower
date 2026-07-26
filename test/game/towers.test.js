import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { spawnEnemy } from '../../src/game/enemies.js';
import { createTower, updateTowers } from '../../src/game/towers.js';
import { TOWER_TYPES } from '../../src/shared/constants.js';
import { makeGame } from '../helpers/game.js';

/**
 * Place a tower right beside the start of the path, where enemies pass immediately.
 *
 * @param {import('../../src/game/state.js').GameState} state
 * @param {string} type
 * @returns {import('../../src/game/towers.js').Tower}
 */
function towerNearSpawn(state, type) {
  return createTower(state, { ownerId: 'p1', type, tileX: 1, tileY: 3 });
}

describe('createTower', () => {
  it('sits at the centre of its tile', () => {
    const state = makeGame();
    const tower = createTower(state, { ownerId: 'p1', type: 'pistol', tileX: 4, tileY: 7 });

    assert.equal(tower.x, 4.5);
    assert.equal(tower.y, 7.5);
  });

  it('is ready to fire immediately', () => {
    // Building mid-wave is allowed and is usually a panic reaction; making the new
    // penguin sit out a cooldown would punish exactly that.
    const state = makeGame();
    assert.equal(towerNearSpawn(state, 'sniper').cooldownMs, 0);
  });

  it('records its owner and type', () => {
    const state = makeGame();
    const tower = createTower(state, { ownerId: 'p1', type: 'bomber', tileX: 2, tileY: 2 });

    assert.equal(tower.ownerId, 'p1');
    assert.equal(tower.type, 'bomber');
    assert.equal(tower.spec, TOWER_TYPES.bomber);
  });

  it('throws on an unknown type', () => {
    const state = makeGame();
    assert.throws(
      () => createTower(state, { ownerId: 'p1', type: 'bazooka', tileX: 2, tileY: 2 }),
      TypeError,
    );
  });
});

describe('updateTowers', () => {
  it('fires at an enemy in range', () => {
    const state = makeGame();
    towerNearSpawn(state, 'pistol');
    spawnEnemy(state, 'walker');

    updateTowers(state, 50);

    assert.equal(state.projectiles.length, 1);
  });

  it('does not fire when nothing is in range', () => {
    const state = makeGame();
    createTower(state, { ownerId: 'p1', type: 'pistol', tileX: 8, tileY: 11 });
    spawnEnemy(state, 'walker');

    updateTowers(state, 50);

    assert.equal(state.projectiles.length, 0);
  });

  it('does not fire at an empty board', () => {
    const state = makeGame();
    towerNearSpawn(state, 'pistol');

    updateTowers(state, 1000);

    assert.equal(state.projectiles.length, 0);
  });

  it('respects its rate of fire over time', () => {
    const state = makeGame();
    towerNearSpawn(state, 'pistol');
    const enemy = spawnEnemy(state, 'walker');

    // One second at 3 shots/sec. Pin the enemy in place so this measures cadence only.
    for (let i = 0; i < 20; i += 1) {
      enemy.progress = 0.5;
      updateTowers(state, 50);
    }

    assert.equal(state.projectiles.length, TOWER_TYPES.pistol.fireRate);
  });

  it('does not bank charges while idle', () => {
    // A tower that accumulated cooldown with no targets would dump a burst the instant
    // a wave appeared, which reads as a bug and breaks the tuning.
    const state = makeGame();
    towerNearSpawn(state, 'pistol');

    updateTowers(state, 10_000);
    spawnEnemy(state, 'walker');
    updateTowers(state, 50);

    assert.equal(state.projectiles.length, 1, 'exactly one shot, not a stored burst');
  });

  it('carries cooldown remainder forward instead of rounding down its rate', () => {
    // The bomber's 0.7/sec interval (~1428.57ms) is not a multiple of the 50ms tick.
    // Assigning the interval rather than adding it would silently quantise every
    // tower's rate to the tick and make the tuning table a lie.
    const state = makeGame();
    towerNearSpawn(state, 'bomber');
    const enemy = spawnEnemy(state, 'walker');

    const seconds = 100;
    for (let i = 0; i < seconds * 20; i += 1) {
      enemy.progress = 0.5;
      updateTowers(state, 50);
      state.projectiles.length = Math.min(state.projectiles.length, 10_000);
    }

    const expected = TOWER_TYPES.bomber.fireRate * seconds;
    const actual = state.projectiles.length;
    assert.ok(
      Math.abs(actual - expected) <= 1,
      `expected about ${expected} shots over ${seconds}s, got ${actual}`,
    );
  });

  it('gives the sniper more reach than the pistol', () => {
    const state = makeGame();
    const enemy = spawnEnemy(state, 'walker');
    enemy.progress = 5.5;

    const pistolState = makeGame();
    const pistolEnemy = spawnEnemy(pistolState, 'walker');
    pistolEnemy.progress = 5.5;

    createTower(state, { ownerId: 'p1', type: 'sniper', tileX: 1, tileY: 3 });
    createTower(pistolState, { ownerId: 'p1', type: 'pistol', tileX: 1, tileY: 3 });

    updateTowers(state, 50);
    updateTowers(pistolState, 50);

    assert.equal(state.projectiles.length, 1, 'sniper reaches');
    assert.equal(pistolState.projectiles.length, 0, 'pistol does not');
  });

  it('lets several towers fire at the same enemy in one tick', () => {
    const state = makeGame();
    createTower(state, { ownerId: 'p1', type: 'pistol', tileX: 1, tileY: 3 });
    createTower(state, { ownerId: 'p1', type: 'pistol', tileX: 2, tileY: 3 });
    spawnEnemy(state, 'walker');

    updateTowers(state, 50);

    assert.equal(state.projectiles.length, 2);
  });
});
