/**
 * Fish: earning it and spending it.
 *
 * The rule that shapes this module is that income is *shared* while wallets are not.
 * Every player receives the full bounty for every kill — the bounty is not split — so a
 * team of four accumulates roughly four times a solo player's money. Enemy hit points
 * are scaled by headcount to compensate; see `hpScaleFor` in the constants.
 */

/**
 * Pay a bounty to every player in the game.
 *
 * Deliberately pays the full amount to each player rather than dividing it. Splitting
 * would make each additional player a liability rather than an ally, which is the
 * opposite of a co-operative game.
 *
 * @param {import('./state.js').GameState} state
 * @param {number} amount Fish paid to each player.
 * @returns {void}
 */
export function payBountyToAll(state, amount) {
  for (const player of state.players.values()) {
    player.fish += amount;
  }
}

/**
 * Attempt to debit a player.
 *
 * Returns a boolean rather than throwing: failing to afford something is an ordinary
 * outcome of play, not an exceptional condition, and the caller turns it into a
 * rejection the player sees.
 *
 * @param {import('./state.js').GameState} state
 * @param {string} playerId
 * @param {number} cost
 * @returns {boolean} True when the player was charged; false when they could not afford
 *   it or are not in the game, in which case nothing was debited.
 */
export function tryCharge(state, playerId, cost) {
  const player = state.players.get(playerId);
  if (player === undefined) return false;
  if (player.fish < cost) return false;

  player.fish -= cost;
  return true;
}

/**
 * Refund a player, used when a placement is rolled back after being charged.
 *
 * @param {import('./state.js').GameState} state
 * @param {string} playerId
 * @param {number} amount
 * @returns {void}
 */
export function refund(state, playerId, amount) {
  const player = state.players.get(playerId);
  if (player !== undefined) player.fish += amount;
}
