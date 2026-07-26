import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { spawnEnemy } from '../../src/game/enemies.js';
import { advanceProjectiles, createProjectile } from '../../src/game/projectiles.js';
import { createTower } from '../../src/game/towers.js';
import { TOWER_TYPES } from '../../src/shared/constants.js';
import { positionAt } from '../../src/shared/map.js';
import { makeGame, player } from '../helpers/game.js';

/**
 * @param {import('../../src/game/state.js').GameState} state
 * @param {string} type
 * @returns {import('../../src/game/towers.js').Tower}
 */
function tower(state, type) {
  return createTower(state, { ownerId: 'p1', type, tileX: 1, tileY: 3 });
}

describe('advanceProjectiles', () => {
  it('moves a projectile towards its target', () => {
    const state = makeGame();
    const enemy = spawnEnemy(state, 'walker');
    enemy.progress = 6;
    const projectile = createProjectile(state, tower(state, 'sniper'), enemy);
    const start = { x: projectile.x, y: projectile.y };

    advanceProjectiles(state, 20);

    const target = positionAt(enemy.progress);
    const before = (start.x - target.x) ** 2 + (start.y - target.y) ** 2;
    const after = (projectile.x - target.x) ** 2 + (projectile.y - target.y) ** 2;
    assert.ok(after < before, 'projectile must close on its target');
  });

  it('damages the target on arrival', () => {
    const state = makeGame();
    const enemy = spawnEnemy(state, 'walker');
    enemy.progress = 1;
    createProjectile(state, tower(state, 'pistol'), enemy);

    // A pistol round at 14 tiles/sec covers the short gap well within a second.
    for (let i = 0; i < 20 && state.projectiles.length > 0; i += 1) {
      advanceProjectiles(state, 50);
    }

    assert.equal(state.projectiles.length, 0, 'projectile must be consumed');
    assert.equal(enemy.hp, enemy.maxHp - TOWER_TYPES.pistol.damage);
  });

  it('re-homes onto a moving target rather than flying at stale coordinates', () => {
    const state = makeGame();
    const enemy = spawnEnemy(state, 'runner');
    enemy.progress = 2;
    createProjectile(state, tower(state, 'pistol'), enemy);

    for (let i = 0; i < 40 && state.projectiles.length > 0; i += 1) {
      enemy.progress += 0.2;
      advanceProjectiles(state, 50);
    }

    assert.ok(enemy.hp < enemy.maxHp, 'a moving target must still be hit');
  });

  it('lets a single-target round fizzle when its target dies mid-flight', () => {
    // The cost of slow projectiles, and a real part of the sniper trade-off.
    const state = makeGame();
    const enemy = spawnEnemy(state, 'walker');
    enemy.progress = 6;
    const other = spawnEnemy(state, 'walker');
    other.progress = 6;

    createProjectile(state, tower(state, 'sniper'), enemy);
    enemy.hp = 0;

    for (let i = 0; i < 40 && state.projectiles.length > 0; i += 1) {
      advanceProjectiles(state, 50);
    }

    assert.equal(other.hp, other.maxHp, 'a fizzled round must not pick a new victim');
  });

  it('detonates splash where it was aimed even if the target died in flight', () => {
    // Which is exactly why bombing a dense cluster is worth doing.
    const state = makeGame();
    const doomed = spawnEnemy(state, 'walker');
    const neighbour = spawnEnemy(state, 'walker');
    doomed.progress = 6;
    neighbour.progress = 6.2;

    createProjectile(state, tower(state, 'bomber'), doomed);
    doomed.hp = 0;

    for (let i = 0; i < 60 && state.projectiles.length > 0; i += 1) {
      advanceProjectiles(state, 50);
    }

    assert.ok(neighbour.hp < neighbour.maxHp, 'splash must still land');
  });

  it('damages every enemy inside the blast radius', () => {
    const state = makeGame();
    const a = spawnEnemy(state, 'walker');
    const b = spawnEnemy(state, 'walker');
    const c = spawnEnemy(state, 'walker');
    a.progress = 6;
    b.progress = 6.3;
    c.progress = 6.6;

    createProjectile(state, tower(state, 'bomber'), a);
    for (let i = 0; i < 60 && state.projectiles.length > 0; i += 1) {
      advanceProjectiles(state, 50);
    }

    assert.ok(a.hp < a.maxHp && b.hp < b.maxHp && c.hp < c.maxHp, 'all three should be hit');
  });

  it('spares enemies outside the blast radius', () => {
    const state = makeGame();
    const target = spawnEnemy(state, 'walker');
    const distant = spawnEnemy(state, 'walker');
    target.progress = 6;
    distant.progress = 25;

    createProjectile(state, tower(state, 'bomber'), target);
    for (let i = 0; i < 60 && state.projectiles.length > 0; i += 1) {
      advanceProjectiles(state, 50);
    }

    assert.equal(distant.hp, distant.maxHp);
  });

  it('never leaves a projectile orbiting its target forever', () => {
    // Without an arrival threshold a fast projectile steps past its target every tick
    // and never registers a hit.
    const state = makeGame();
    const enemy = spawnEnemy(state, 'walker');
    enemy.progress = 1.2;
    createProjectile(state, tower(state, 'sniper'), enemy);

    for (let i = 0; i < 200 && state.projectiles.length > 0; i += 1) {
      advanceProjectiles(state, 50);
    }

    assert.equal(state.projectiles.length, 0, 'projectile must resolve, not orbit');
  });

  it('is a cheap no-op with nothing in flight', () => {
    const state = makeGame();
    assert.doesNotThrow(() => advanceProjectiles(state, 50));
    assert.deepEqual(state.projectiles, []);
  });

  it('pays a bounty when a projectile lands the killing blow', () => {
    const state = makeGame();
    const before = player(state, 'p1').fish;
    const enemy = spawnEnemy(state, 'walker');
    enemy.progress = 1;
    enemy.hp = 1;

    createProjectile(state, tower(state, 'pistol'), enemy);
    for (let i = 0; i < 40 && state.projectiles.length > 0; i += 1) {
      advanceProjectiles(state, 50);
    }

    assert.ok(player(state, 'p1').fish > before, 'the kill must pay out');
  });
});
