/**
 * Player intents applied to the simulation.
 *
 * The server never trusts a client's view of the world. A client says "I want a sniper
 * on tile 7,3"; this module decides whether that is true, and returns a specific reason
 * when it is not. Every rejection reason is a constant the client branches on — nothing
 * anywhere matches on message text.
 *
 * Commands are applied one at a time, in arrival order, at the start of a tick. That is
 * what makes two players clicking the same tile in the same tick deterministic: the
 * first one applied wins, the second gets TILE_OCCUPIED, and the outcome is identical
 * on every run.
 */

import { MAX_TOWER_LEVEL, PHASE, TOWER_TYPES, upgradeCostFor } from '../shared/constants.js';
import { isBuildable, isInBounds, tileKey } from '../shared/map.js';
import { REJECT_REASON } from '../shared/protocol.js';

import { tryCharge } from './economy.js';
import { createTower, towerAt } from './towers.js';

/**
 * @typedef {{ ok: true }} CommandOk
 * @typedef {{ ok: false, reason: string }} CommandRejected
 * @typedef {CommandOk | CommandRejected} CommandResult
 */

/**
 * Phases during which a penguin may be placed.
 *
 * Building mid-wave is deliberately allowed — reacting to a wave going badly is a core
 * part of playing, and forbidding it would make the build phase the only decision point.
 */
/** @type {ReadonlySet<string>} */
const BUILDABLE_PHASES = new Set([PHASE.BUILD, PHASE.WAVE]);

/**
 * Place a penguin.
 *
 * Checks run cheapest-and-most-specific first so the reason returned is the one the
 * player most needs to see. Notably, affordability is checked *last*: telling someone
 * they cannot afford a tile that was never buildable would be actively misleading.
 *
 * @param {import('./state.js').GameState} state
 * @param {string} playerId
 * @param {{ tileX: number, tileY: number, towerType: string }} cmd
 * @returns {CommandResult}
 */
function applyPlace(state, playerId, cmd) {
  const player = state.players.get(playerId);
  if (player === undefined) {
    return { ok: false, reason: REJECT_REASON.NOT_A_PLAYER };
  }

  if (!BUILDABLE_PHASES.has(state.phase)) {
    return { ok: false, reason: REJECT_REASON.WRONG_PHASE };
  }

  const spec = TOWER_TYPES[cmd.towerType];
  if (spec === undefined) {
    return { ok: false, reason: REJECT_REASON.UNKNOWN_TOWER_TYPE };
  }

  if (!isInBounds(cmd.tileX, cmd.tileY)) {
    return { ok: false, reason: REJECT_REASON.OUT_OF_BOUNDS };
  }

  if (!isBuildable(cmd.tileX, cmd.tileY)) {
    return { ok: false, reason: REJECT_REASON.TILE_NOT_BUILDABLE };
  }

  const key = tileKey(cmd.tileX, cmd.tileY);
  if (state.occupancy.has(key)) {
    return { ok: false, reason: REJECT_REASON.TILE_OCCUPIED };
  }

  if (!tryCharge(state, playerId, spec.cost)) {
    return { ok: false, reason: REJECT_REASON.INSUFFICIENT_FISH };
  }

  const tower = createTower(state, {
    ownerId: playerId,
    type: cmd.towerType,
    tileX: cmd.tileX,
    tileY: cmd.tileY,
  });
  state.occupancy.set(key, tower.id);

  return { ok: true };
}

/**
 * Spend fish to raise a placed penguin's level.
 *
 * Any player may upgrade any penguin, and any player may pay for it — the buyer is
 * whoever clicked. Towers belong to the team, and an upgrade a teammate cannot fund
 * because they did not place it would make co-operation harder than playing alone.
 *
 * @param {import('./state.js').GameState} state
 * @param {string} playerId
 * @param {{ tileX: number, tileY: number }} cmd
 * @returns {CommandResult}
 */
function applyUpgrade(state, playerId, cmd) {
  if (!state.players.has(playerId)) {
    return { ok: false, reason: REJECT_REASON.NOT_A_PLAYER };
  }

  if (!BUILDABLE_PHASES.has(state.phase)) {
    return { ok: false, reason: REJECT_REASON.WRONG_PHASE };
  }

  if (!isInBounds(cmd.tileX, cmd.tileY)) {
    return { ok: false, reason: REJECT_REASON.OUT_OF_BOUNDS };
  }

  const tower = towerAt(state, cmd.tileX, cmd.tileY);
  if (tower === undefined) {
    return { ok: false, reason: REJECT_REASON.NO_TOWER_HERE };
  }

  // Checked before affordability, so a penguin at the cap says so rather than telling a
  // player they cannot afford something that was never for sale.
  if (tower.level >= MAX_TOWER_LEVEL) {
    return { ok: false, reason: REJECT_REASON.ALREADY_MAX_LEVEL };
  }

  const cost = upgradeCostFor(tower.spec, tower.level);
  if (!tryCharge(state, playerId, cost)) {
    return { ok: false, reason: REJECT_REASON.INSUFFICIENT_FISH };
  }

  tower.level += 1;
  tower.invested += cost;

  state.events.push({
    kind: 'towerUpgraded',
    playerId,
    towerType: tower.type,
    level: tower.level,
    cost,
    tileX: tower.tileX,
    tileY: tower.tileY,
  });

  return { ok: true };
}

/**
 * Set a player's ready flag.
 *
 * Only meaningful during the build phase; readying at any other time is refused rather
 * than silently stored, so a stale click cannot arm the next wave.
 *
 * @param {import('./state.js').GameState} state
 * @param {string} playerId
 * @param {{ value: boolean }} cmd
 * @returns {CommandResult}
 */
function applyReady(state, playerId, cmd) {
  const player = state.players.get(playerId);
  if (player === undefined) {
    return { ok: false, reason: REJECT_REASON.NOT_A_PLAYER };
  }

  if (state.phase !== PHASE.BUILD && state.phase !== PHASE.LOBBY) {
    return { ok: false, reason: REJECT_REASON.WRONG_PHASE };
  }

  player.ready = cmd.value;
  return { ok: true };
}

/**
 * Apply one validated command.
 *
 * The message has already passed protocol validation, so shapes are trusted here; what
 * is checked is whether the *game* permits it.
 *
 * @param {import('./state.js').GameState} state
 * @param {string} playerId
 * @param {{ type: string } & Record<string, unknown>} cmd
 * @returns {CommandResult}
 */
export function applyCommand(state, playerId, cmd) {
  switch (cmd.type) {
    case 'place':
      return applyPlace(state, playerId, /** @type {any} */ (cmd));
    case 'upgrade':
      return applyUpgrade(state, playerId, /** @type {any} */ (cmd));
    case 'ready':
      return applyReady(state, playerId, /** @type {any} */ (cmd));
    default:
      // Room-level messages (hello, playAgain) never reach the simulation. Anything
      // else here means the router and this switch have drifted apart.
      return { ok: false, reason: `unhandled command: ${cmd.type}` };
  }
}
