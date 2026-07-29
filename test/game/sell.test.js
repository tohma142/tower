/**
 * Selling a placed penguin.
 *
 * Two properties carry most of the weight here and neither is obvious from the diff:
 * the refund goes to whoever *paid* rather than whoever clicked, and selling can never
 * be a net gain. Both are exploits in a game where income is shared but wallets are not.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyCommand } from '../../src/game/commands.js';
import { drainEvents, startWave } from '../../src/game/state.js';
import {
  MAX_TOWER_LEVEL,
  PHASE,
  SELL_REFUND_RATE,
  TOWER_TYPES,
  sellRefundFor,
  upgradeCostFor,
} from '../../src/shared/constants.js';
import { isBuildable, tileKey } from '../../src/shared/map.js';
import { REJECT_REASON } from '../../src/shared/protocol.js';
import { grantFish, makeGame, player, rejection } from '../helpers/game.js';

/** Two buildable tiles, found rather than assumed. */
const [TILE_A, TILE_B] = (() => {
  /** @type {Array<{ x: number, y: number }>} */
  const found = [];
  for (let x = 0; x < 20 && found.length < 2; x += 1) {
    for (let y = 0; y < 12 && found.length < 2; y += 1) {
      if (isBuildable(x, y)) found.push({ x, y });
    }
  }
  if (found.length < 2) throw new Error('map needs at least two buildable tiles');
  return found;
})();

/**
 * @param {import('../../src/game/state.js').GameState} state
 * @param {string} playerId
 * @param {{ x: number, y: number }} tile
 * @param {string} [towerType]
 */
function place(state, playerId, tile, towerType = 'pistol') {
  return applyCommand(state, playerId, {
    type: 'place',
    tileX: tile.x,
    tileY: tile.y,
    towerType,
  });
}

/**
 * @param {import('../../src/game/state.js').GameState} state
 * @param {string} playerId
 * @param {{ x: number, y: number }} tile
 */
function sell(state, playerId, tile) {
  return applyCommand(state, playerId, { type: 'sell', tileX: tile.x, tileY: tile.y });
}

/**
 * @param {import('../../src/game/state.js').GameState} state
 * @param {string} playerId
 * @param {{ x: number, y: number }} tile
 */
function upgrade(state, playerId, tile) {
  return applyCommand(state, playerId, { type: 'upgrade', tileX: tile.x, tileY: tile.y });
}

describe('sell — the refund', () => {
  it('pays back the configured fraction of what the penguin cost', () => {
    const state = makeGame();
    place(state, 'p1', TILE_A, 'sniper');
    const afterBuying = player(state, 'p1').fish;

    assert.equal(sell(state, 'p1', TILE_A).ok, true);

    const expected = sellRefundFor(TOWER_TYPES.sniper.cost);
    assert.equal(player(state, 'p1').fish, afterBuying + expected);
  });

  it('never returns more than was spent, at any tower price', () => {
    // The property that matters is not the exact rate but that a sell-and-rebuy loop
    // cannot print fish. Asserted across every tower rather than one example.
    for (const spec of Object.values(TOWER_TYPES)) {
      assert.ok(
        sellRefundFor(spec.cost) < spec.cost,
        `selling a ${spec.name} returns ${sellRefundFor(spec.cost)} of ${spec.cost}`,
      );
    }
  });

  it('leaves a player poorer after a buy-and-sell round trip', () => {
    const state = makeGame();
    const before = player(state, 'p1').fish;

    place(state, 'p1', TILE_A, 'bomber');
    sell(state, 'p1', TILE_A);

    assert.ok(
      player(state, 'p1').fish < before,
      'a round trip must cost something, or placement carries no risk',
    );
  });

  it('rounds the refund down rather than up', () => {
    // An odd invested total is where a rounding bug would show. Ceiling here would let a
    // long enough cycle of buys and sells accumulate fish out of nothing.
    assert.equal(sellRefundFor(101), Math.floor(101 * SELL_REFUND_RATE));
    assert.ok(sellRefundFor(101) <= 101 * SELL_REFUND_RATE);
  });

  it('cannot be driven negative by a nonsense investment', () => {
    assert.equal(sellRefundFor(0), 0);
    assert.equal(sellRefundFor(-50), 0);
  });
});

describe('sell — who gets paid', () => {
  it('refunds the player who paid, not the player who clicked', () => {
    // Wallets are per-player. Paying the seller would let one player liquidate another's
    // investment into their own pocket, which is griefing with extra steps.
    const state = makeGame({ players: ['a', 'b'] });
    place(state, 'a', TILE_A, 'pistol');

    const aBefore = player(state, 'a').fish;
    const bBefore = player(state, 'b').fish;

    assert.equal(sell(state, 'b', TILE_A).ok, true);

    assert.equal(player(state, 'a').fish, aBefore + sellRefundFor(TOWER_TYPES.pistol.cost));
    assert.equal(player(state, 'b').fish, bBefore, 'the seller must not profit');
  });

  it('pays the seller when the original owner has left the game', () => {
    // Their fish has nowhere to go. Dropping it on the floor would quietly destroy money
    // the team earned.
    const state = makeGame({ players: ['a', 'b'] });
    place(state, 'a', TILE_A, 'pistol');
    state.players.delete('a');

    const bBefore = player(state, 'b').fish;
    assert.equal(sell(state, 'b', TILE_A).ok, true);

    assert.equal(player(state, 'b').fish, bBefore + sellRefundFor(TOWER_TYPES.pistol.cost));
  });
});

describe('sell — the board', () => {
  it('removes the penguin and frees the tile for rebuilding', () => {
    const state = makeGame();
    grantFish(state, 'p1');
    place(state, 'p1', TILE_A, 'pistol');

    sell(state, 'p1', TILE_A);

    assert.equal(state.towers.length, 0);
    assert.equal(state.occupancy.has(tileKey(TILE_A.x, TILE_A.y)), false);
    assert.equal(place(state, 'p1', TILE_A, 'sniper').ok, true, 'the tile must be reusable');
  });

  it('removes only the penguin that was sold', () => {
    const state = makeGame();
    grantFish(state, 'p1');
    place(state, 'p1', TILE_A, 'pistol');
    place(state, 'p1', TILE_B, 'sniper');

    sell(state, 'p1', TILE_A);

    assert.equal(state.towers.length, 1);
    assert.equal(state.towers[0].type, 'sniper');
    assert.equal(state.occupancy.has(tileKey(TILE_B.x, TILE_B.y)), true);
  });

  it('announces the sale with the refund, so the team can see the money move', () => {
    const state = makeGame();
    place(state, 'p1', TILE_A, 'pistol');
    drainEvents(state);

    sell(state, 'p1', TILE_A);

    const event = drainEvents(state).find((e) => e.kind === 'towerSold');
    assert.ok(event !== undefined, 'selling must be visible to everyone, not just the seller');
    assert.equal(event.refund, sellRefundFor(TOWER_TYPES.pistol.cost));
    assert.equal(event.towerType, 'pistol');
  });
});

describe('sell — rejections', () => {
  it('refuses a tile with nothing on it', () => {
    const state = makeGame();

    assert.equal(rejection(sell(state, 'p1', TILE_A)), REJECT_REASON.NO_TOWER_HERE);
  });

  it('refuses a tile off the board', () => {
    const state = makeGame();

    assert.equal(rejection(sell(state, 'p1', { x: -1, y: 0 })), REJECT_REASON.OUT_OF_BOUNDS);
  });

  it('refuses someone who is not seated', () => {
    const state = makeGame();
    place(state, 'p1', TILE_A, 'pistol');

    assert.equal(rejection(sell(state, 'ghost', TILE_A)), REJECT_REASON.NOT_A_PLAYER);
  });

  it('refuses to pay out after the game is over', () => {
    const state = makeGame();
    place(state, 'p1', TILE_A, 'pistol');
    state.phase = PHASE.GAME_OVER;

    assert.equal(rejection(sell(state, 'p1', TILE_A)), REJECT_REASON.WRONG_PHASE);
  });

  it('leaves the board untouched when it refuses', () => {
    const state = makeGame();
    place(state, 'p1', TILE_A, 'pistol');
    state.phase = PHASE.GAME_OVER;
    const before = player(state, 'p1').fish;

    sell(state, 'p1', TILE_A);

    assert.equal(state.towers.length, 1, 'a refused sell must not remove the penguin');
    assert.equal(player(state, 'p1').fish, before, 'a refused sell must not pay out');
  });
});

describe('sell — mid-wave', () => {
  it('is allowed during a wave, matching placement', () => {
    // Placement is deliberately allowed mid-wave so a player can react to trouble.
    // Selling follows the same rule; the 30% haircut is what keeps it from being free.
    const state = makeGame();
    grantFish(state, 'p1');
    place(state, 'p1', TILE_A, 'pistol');
    startWave(state);
    assert.equal(state.phase, PHASE.WAVE);

    assert.equal(sell(state, 'p1', TILE_A).ok, true);
  });
});

describe('sell — with upgrades', () => {
  it('refunds against the upgrades too, not just the purchase price', () => {
    // The interaction between selling and upgrading, which neither feature could test on
    // its own: they were built on separate branches and first met at the merge. If
    // `invested` stopped tracking upgrade spend, a fully-upgraded Sniper would refund as
    // though it were a fresh one and the difference would vanish silently.
    const state = makeGame();
    grantFish(state, 'p1');
    place(state, 'p1', TILE_A, 'sniper');

    let spent = TOWER_TYPES.sniper.cost;
    for (let level = 1; level < MAX_TOWER_LEVEL; level += 1) {
      spent += upgradeCostFor(TOWER_TYPES.sniper, level);
      assert.equal(upgrade(state, 'p1', TILE_A).ok, true, `upgrade to ${level + 1} refused`);
    }

    const before = player(state, 'p1').fish;
    assert.equal(sell(state, 'p1', TILE_A).ok, true);

    assert.equal(player(state, 'p1').fish - before, sellRefundFor(spent));
    assert.ok(
      sellRefundFor(spent) > sellRefundFor(TOWER_TYPES.sniper.cost),
      'an upgraded penguin must be worth more than an un-upgraded one',
    );
  });

  it('still cannot be turned into a profit by upgrading first', () => {
    // The no-free-money property from the top of this file, re-checked across the one
    // path that adds fish to a penguin after it is placed.
    const state = makeGame();
    grantFish(state, 'p1');

    const before = player(state, 'p1').fish;
    place(state, 'p1', TILE_A, 'bomber');
    upgrade(state, 'p1', TILE_A);
    sell(state, 'p1', TILE_A);

    assert.ok(
      player(state, 'p1').fish < before,
      'buy, upgrade and sell must leave a player worse off',
    );
  });

  it('reports the refund it actually paid in the event', () => {
    const state = makeGame();
    grantFish(state, 'p1');
    place(state, 'p1', TILE_A, 'pistol');
    upgrade(state, 'p1', TILE_A);
    drainEvents(state);

    const paid = player(state, 'p1').fish;
    sell(state, 'p1', TILE_A);
    const sold = drainEvents(state).find((e) => e.kind === 'towerSold');

    assert.equal(sold?.refund, player(state, 'p1').fish - paid);
  });
});

describe('sell — refund arithmetic', () => {
  it('does not lose a fish to binary floating point', () => {
    // 90 * 0.7 is 62.99999999999999 in IEEE754, so a bare floor pays 62. 90 is a Pistol
    // upgraded once — the most ordinary sell in the game — and it only became reachable
    // when upgrades started adding to `invested`.
    assert.equal(sellRefundFor(90), 63);
  });

  it('pays exactly 70% floored, at every total a penguin can reach', () => {
    // Driven over the range rather than at the one value that caught it, because the
    // failure is a property of the arithmetic and 90 is not the only total affected.
    for (let invested = 0; invested <= 2000; invested += 1) {
      assert.equal(
        sellRefundFor(invested),
        Math.floor(Math.round(invested * 7) / 10),
        `refund for ${invested} invested`,
      );
    }
  });

  it('never pays back more than was put in', () => {
    for (let invested = 0; invested <= 2000; invested += 1) {
      assert.ok(sellRefundFor(invested) < invested || invested === 0);
    }
  });
});
