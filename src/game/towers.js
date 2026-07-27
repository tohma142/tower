/**
 * Penguins: where they stand, what they shoot at, and how often.
 *
 * A tower is stationary and stateless apart from its cooldown, so this module is almost
 * entirely "pick a target, fire if ready". The interesting decisions live in the
 * targeting rule (furthest along the path) and in cooldown accounting.
 */

import { TOWER_TYPES, isCombatTower, levelMultiplier } from '../shared/constants.js';
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
 * @property {number} level     1-based. Scales this penguin's output — damage if it
 *                              shoots, income if it does not.
 * @property {number} invested  Total fish sunk into it, purchase price plus every
 *                              upgrade. One field to read rather than a formula to
 *                              rediscover wherever the total matters — and what the
 *                              sell refund is a fraction of, so an upgraded penguin
 *                              refunds against everything it cost.
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
    level: 1,
    invested: spec.cost,
    spec,
  };
  state.nextId += 1;

  state.towers.push(tower);
  return tower;
}

/**
 * Remove a placed penguin from the board.
 *
 * Clears the occupancy entry as well as the tower list. Those two are the same fact
 * stored twice — a tower left in `occupancy` after leaving `towers` makes its tile
 * permanently unbuildable, with nothing drawn there to explain why.
 *
 * @param {import('./state.js').GameState} state
 * @param {Tower} tower
 * @returns {boolean} False when the tower was not on the board.
 */
export function removeTower(state, tower) {
  const index = state.towers.indexOf(tower);
  if (index === -1) return false;

  state.towers.splice(index, 1);
  state.occupancy.delete(tileKey(tower.tileX, tower.tileY));

  // In-flight projectiles are deliberately left alone. They belong to the world once
  // fired, not to the penguin that fired them, and cancelling them would let a player
  // un-hit an enemy that a shot was already going to kill.
  return true;
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
 * A penguin's damage at its current level.
 *
 * Read here rather than from `spec.damage` anywhere downstream, so there is exactly one
 * place that knows levels affect damage. A projectile that captured `spec.damage`
 * directly would ignore upgrades and nothing would fail.
 *
 * @param {Tower} tower
 * @returns {number}
 */
export function towerDamage(tower) {
  return tower.spec.damage * levelMultiplier(tower.level);
}

/**
 * Fish every Fisher on the board pays each player when a wave is cleared.
 *
 * Paid to every player rather than split, exactly like a kill bounty. Splitting it would
 * make a Fisher worth less the more friends you have, which is the opposite of what a
 * co-operative game should reward — and enemy hit points already scale with headcount,
 * so a per-player payout stays in step with the difficulty it is funding.
 *
 * @param {import('./state.js').GameState} state
 * @returns {number} Fish per player, zero when nobody has built one.
 */
export function totalIncome(state) {
  let total = 0;
  for (const tower of state.towers) total += tower.spec.income * levelMultiplier(tower.level);
  return total;
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
    // Support penguins have no weapon. Skipping them here rather than giving them a
    // range of zero keeps them out of the targeting loop entirely, and means a fireRate
    // of zero never becomes a division by zero in the cooldown below.
    if (!isCombatTower(tower.spec)) continue;

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
    const target = findTarget(state.enemies, tower, rangeSquared);
    if (target === null) {
      tower.cooldownMs = 0;
      continue;
    }

    createProjectile(state, tower, target, towerDamage(tower));

    // Add the interval rather than assigning it, so a cooldown that overshot into
    // negative territory carries the remainder forward. Assigning would quietly lower
    // every tower's effective rate of fire to a multiple of the tick.
    tower.cooldownMs += 1000 / tower.spec.fireRate;
  }
}
