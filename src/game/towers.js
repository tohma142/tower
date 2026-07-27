/**
 * Penguins: where they stand, what they shoot at, and how often.
 *
 * A tower is stationary and stateless apart from its cooldown, so this module is almost
 * entirely "pick a target, fire if ready". The interesting decisions live in the
 * targeting rule (furthest along the path) and in cooldown accounting.
 */

import { DEFAULT_TARGET_PRIORITY, TOWER_TYPES } from '../shared/constants.js';
import { tileKey } from '../shared/map.js';

import { findTarget } from './enemies.js';
import { createProjectile } from './projectiles.js';

/**
 * @typedef {object} Tower
 * @property {number} id
 * @property {string} ownerId    Player who paid for it. Purely informational — towers
 *                               belong to the team and fire regardless of who is connected.
 * @property {string} type       Key into TOWER_TYPES.
 * @property {number} tileX
 * @property {number} tileY
 * @property {number} x          World coords of the tile centre.
 * @property {number} y
 * @property {number} cooldownMs Milliseconds until it may fire again.
 * @property {string} priority   One of TARGET_PRIORITY: how it picks between enemies in
 *                               range. Per-penguin, not per-type, because the useful
 *                               setting depends on where it stands.
 * @property {import('../shared/constants.js').TowerType} spec
 */

/**
 * Build a tower record. Placement legality is the command layer's job; by the time this
 * runs the tile is known to be free and buildable and the player has been charged.
 *
 * @param {import('./state.js').GameState} state
 * @param {object} options
 * @param {string} options.ownerId
 * @param {string} options.type
 * @param {number} options.tileX
 * @param {number} options.tileY
 * @returns {Tower}
 * @throws {TypeError} If the tower type is unknown.
 */
export function createTower(state, { ownerId, type, tileX, tileY }) {
  const spec = TOWER_TYPES[type];
  if (spec === undefined) {
    throw new TypeError(`unknown tower type: ${type}`);
  }

  /** @type {Tower} */
  const tower = {
    id: state.nextId,
    ownerId,
    type,
    tileX,
    tileY,
    x: tileX + 0.5,
    y: tileY + 0.5,
    // Ready immediately. Making a fresh penguin wait out a cooldown would punish
    // building mid-wave, which is exactly when a player is reacting to trouble.
    cooldownMs: 0,
    priority: DEFAULT_TARGET_PRIORITY,
    spec,
  };
  state.nextId += 1;

  state.towers.push(tower);
  return tower;
}

/**
 * Find the penguin standing on a tile.
 *
 * @param {import('./state.js').GameState} state
 * @param {number} tileX
 * @param {number} tileY
 * @returns {Tower | undefined}
 */
export function towerAt(state, tileX, tileY) {
  const id = state.occupancy.get(tileKey(tileX, tileY));
  if (id === undefined) return undefined;
  return state.towers.find((t) => t.id === id);
}

/**
 * Tick every tower: run down cooldowns, acquire targets, and fire.
 *
 * @param {import('./state.js').GameState} state
 * @param {number} dtMs
 * @returns {void}
 */
export function updateTowers(state, dtMs) {
  if (state.towers.length === 0) return;

  for (const tower of state.towers) {
    if (tower.cooldownMs > 0) {
      tower.cooldownMs -= dtMs;
      if (tower.cooldownMs > 0) continue;
    }

    // Nothing to shoot at: hold fire with the cooldown at rest rather than banking
    // charges, so a tower cannot dump several shots the instant a wave appears.
    if (state.enemies.length === 0) {
      tower.cooldownMs = 0;
      continue;
    }

    const rangeSquared = tower.spec.range * tower.spec.range;
    const target = findTarget(state.enemies, tower, rangeSquared, tower.priority);
    if (target === null) {
      tower.cooldownMs = 0;
      continue;
    }

    createProjectile(state, tower, target);

    // Add the interval rather than assigning it, so a cooldown that overshot into
    // negative territory carries the remainder forward. Assigning would quietly lower
    // every tower's effective rate of fire to a multiple of the tick.
    tower.cooldownMs += 1000 / tower.spec.fireRate;
  }
}
