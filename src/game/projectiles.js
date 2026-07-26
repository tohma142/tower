/**
 * Projectiles in flight.
 *
 * Every penguin fires a travelling projectile rather than hitting instantly. That costs
 * a little simulation work but buys two things: the pixel art has something to draw
 * between a penguin and its target, and leading a fast runner becomes a real property
 * of the sniper's slow rate of fire rather than a hidden constant.
 *
 * Projectiles track a target *and* its last known position. When the target dies in
 * flight, a splash projectile still detonates where it was aimed — which is why bombing
 * a dense cluster is worth doing — while a single-target round simply fizzles.
 */

import { positionAt } from '../shared/map.js';

import { damageEnemy, enemyPosition } from './enemies.js';

/**
 * @typedef {object} Projectile
 * @property {number} id
 * @property {number} x            World coords.
 * @property {number} y
 * @property {number} targetId     Enemy id, or -1 once the target is gone.
 * @property {number} tx           Last known target position, steered towards.
 * @property {number} ty
 * @property {number} damage
 * @property {number} splashRadius Tiles; 0 means single-target.
 * @property {number} speed        Tiles per second.
 */

/**
 * Distance at which a projectile counts as having arrived. Without a threshold, a fast
 * projectile can step past its target every tick and orbit it forever.
 */
const HIT_RADIUS = 0.25;

/**
 * Launch a projectile from a tower at an enemy.
 *
 * @param {import('./state.js').GameState} state
 * @param {import('./towers.js').Tower} tower
 * @param {import('./enemies.js').Enemy} target
 * @returns {Projectile}
 */
export function createProjectile(state, tower, target) {
  const spec = tower.spec;
  const targetPos = enemyPosition(target);

  /** @type {Projectile} */
  const projectile = {
    id: state.nextId,
    x: tower.x,
    y: tower.y,
    targetId: target.id,
    tx: targetPos.x,
    ty: targetPos.y,
    damage: spec.damage,
    splashRadius: spec.splashRadius,
    speed: spec.projectileSpeed,
  };
  state.nextId += 1;

  state.projectiles.push(projectile);
  return projectile;
}

/**
 * Resolve a projectile arriving at its destination.
 *
 * @param {import('./state.js').GameState} state
 * @param {Projectile} projectile
 * @param {Map<number, import('./enemies.js').Enemy>} byId
 * @returns {void}
 */
function detonate(state, projectile, byId) {
  if (projectile.splashRadius > 0) {
    const radiusSquared = projectile.splashRadius * projectile.splashRadius;

    // Splash hits everything in the blast, including enemies that were never targeted.
    for (const enemy of state.enemies) {
      if (enemy.hp <= 0) continue;
      const pos = positionAt(enemy.progress);
      const dx = pos.x - projectile.x;
      const dy = pos.y - projectile.y;
      if (dx * dx + dy * dy <= radiusSquared) {
        damageEnemy(state, enemy, projectile.damage);
      }
    }
    return;
  }

  // Single-target: only the intended enemy, and only if it is still alive. A round
  // aimed at something that died mid-flight is wasted, which is the cost of a slow
  // projectile and a deliberate part of the sniper's trade-off.
  const target = byId.get(projectile.targetId);
  if (target !== undefined && target.hp > 0) {
    damageEnemy(state, target, projectile.damage);
  }
}

/**
 * Move every projectile and resolve any that arrive.
 *
 * @param {import('./state.js').GameState} state
 * @param {number} dtMs
 * @returns {void}
 */
export function advanceProjectiles(state, dtMs) {
  if (state.projectiles.length === 0) return;

  const dtSeconds = dtMs / 1000;

  /** @type {Map<number, import('./enemies.js').Enemy>} */
  const byId = new Map();
  for (const enemy of state.enemies) byId.set(enemy.id, enemy);

  /** @type {Projectile[]} */
  const survivors = [];

  for (const projectile of state.projectiles) {
    const target = byId.get(projectile.targetId);
    if (target !== undefined && target.hp > 0) {
      // Re-home: the target is still alive, so steer at where it is now.
      const pos = positionAt(target.progress);
      projectile.tx = pos.x;
      projectile.ty = pos.y;
    } else {
      // Target gone. Keep flying to where it last was; splash still matters there.
      projectile.targetId = -1;
    }

    const dx = projectile.tx - projectile.x;
    const dy = projectile.ty - projectile.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const step = projectile.speed * dtSeconds;

    if (distance <= Math.max(step, HIT_RADIUS)) {
      projectile.x = projectile.tx;
      projectile.y = projectile.ty;
      detonate(state, projectile, byId);
      continue;
    }

    projectile.x += (dx / distance) * step;
    projectile.y += (dy / distance) * step;
    survivors.push(projectile);
  }

  state.projectiles = survivors;
}
