/**
 * Shared setup for simulation tests.
 *
 * The simulation takes time as an argument and reads no clock, so every helper here
 * drives it with an explicit fixed timestep. Nothing sleeps, and a full 15-wave game
 * runs in single-digit milliseconds.
 */

import { applyCommand } from '../../src/game/commands.js';
import { addPlayer, createGameState, startGame, tick } from '../../src/game/state.js';
import { TICK_MS } from '../../src/shared/constants.js';

/**
 * Build a started game with the given players seated.
 *
 * @param {object} [options]
 * @param {string[]} [options.players] Player ids to seat.
 * @returns {import('../../src/game/state.js').GameState}
 */
export function makeGame({ players = ['p1'] } = {}) {
  const state = createGameState();
  players.forEach((id, index) => addPlayer(state, id, `Penguin ${index + 1}`));
  startGame(state);
  return state;
}

/**
 * Advance a fixed number of ticks.
 *
 * @param {import('../../src/game/state.js').GameState} state
 * @param {number} count
 * @param {number} [dtMs]
 * @returns {void}
 */
export function runTicks(state, count, dtMs = TICK_MS) {
  for (let i = 0; i < count; i += 1) tick(state, dtMs);
}

/**
 * Tick until a condition holds.
 *
 * Bounded, and throws rather than looping forever — an infinite loop in a test suite is
 * far harder to diagnose than an explicit failure naming the condition.
 *
 * @param {import('../../src/game/state.js').GameState} state
 * @param {(s: import('../../src/game/state.js').GameState) => boolean} predicate
 * @param {object} [options]
 * @param {number} [options.maxTicks]
 * @param {string} [options.describe] Used in the failure message.
 * @returns {number} Ticks taken.
 */
export function runUntil(state, predicate, { maxTicks = 40_000, describe = 'condition' } = {}) {
  for (let i = 0; i < maxTicks; i += 1) {
    if (predicate(state)) return i;
    tick(state, TICK_MS);
  }
  throw new Error(`${describe} not met within ${maxTicks} ticks`);
}

/**
 * Fetch a seated player, failing loudly if the id is wrong.
 *
 * Tests reach for players constantly; going through here means a typo in an id surfaces
 * as "no such player: pl" rather than as a confusing undefined-property error twenty
 * lines later.
 *
 * @param {import('../../src/game/state.js').GameState} state
 * @param {string} playerId
 * @returns {import('../../src/game/state.js').Player}
 */
export function player(state, playerId) {
  const found = state.players.get(playerId);
  if (found === undefined) throw new Error(`no such player: ${playerId}`);
  return found;
}

/**
 * Give a player enough fish to buy anything, so a test about placement is not
 * accidentally a test about affordability.
 *
 * @param {import('../../src/game/state.js').GameState} state
 * @param {string} playerId
 * @param {number} [amount]
 * @returns {void}
 */
export function grantFish(state, playerId, amount = 100_000) {
  player(state, playerId).fish = amount;
}

/**
 * Assert a command was refused and hand back the reason.
 *
 * CommandResult is a union, so reading `.reason` off it directly does not typecheck —
 * and that is the type system doing its job: a caller that forgets to check `ok` would
 * read `undefined`. This narrows once, in one place.
 *
 * @param {import('../../src/game/commands.js').CommandResult} result
 * @returns {string}
 */
export function rejection(result) {
  if (result.ok) throw new Error('expected the command to be rejected, but it succeeded');
  return result.reason;
}

/**
 * Place a penguin, asserting it succeeded. Use when placement is setup rather than the
 * behaviour under test.
 *
 * @param {import('../../src/game/state.js').GameState} state
 * @param {string} playerId
 * @param {number} tileX
 * @param {number} tileY
 * @param {string} towerType
 * @returns {void}
 */
export function place(state, playerId, tileX, tileY, towerType) {
  const result = applyCommand(state, playerId, { type: 'place', tileX, tileY, towerType });
  if (!result.ok) {
    throw new Error(`setup placement failed at (${tileX},${tileY}): ${result.reason}`);
  }
}
