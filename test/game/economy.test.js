import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { payBountyToAll, refund, tryCharge } from '../../src/game/economy.js';
import { makeGame, player } from '../helpers/game.js';

describe('payBountyToAll', () => {
  it('pays every player the FULL bounty rather than splitting it', () => {
    // This is the defining property of the shared-income model. If this ever becomes a
    // split, each extra player makes the team poorer and co-op becomes a penalty.
    const state = makeGame({ players: ['a', 'b', 'c'] });
    const before = [...state.players.values()].map((p) => p.fish);

    payBountyToAll(state, 15);

    for (const [index, player] of [...state.players.values()].entries()) {
      assert.equal(player.fish, before[index] + 15, 'each player gets the whole bounty');
    }
  });

  it('is a no-op on an empty roster', () => {
    const state = makeGame({ players: [] });
    assert.doesNotThrow(() => payBountyToAll(state, 10));
  });
});

describe('tryCharge', () => {
  it('debits exactly once and reports success', () => {
    const state = makeGame({ players: ['a'] });
    const start = player(state, 'a').fish;

    assert.equal(tryCharge(state, 'a', 50), true);
    assert.equal(player(state, 'a').fish, start - 50);
  });

  it('refuses and debits nothing when the player cannot afford it', () => {
    const state = makeGame({ players: ['a'] });
    player(state, 'a').fish = 40;

    assert.equal(tryCharge(state, 'a', 50), false);
    assert.equal(player(state, 'a').fish, 40, 'balance must be untouched on refusal');
  });

  it('allows spending down to exactly zero', () => {
    const state = makeGame({ players: ['a'] });
    player(state, 'a').fish = 50;

    assert.equal(tryCharge(state, 'a', 50), true);
    assert.equal(player(state, 'a').fish, 0);
  });

  it('refuses an unknown player rather than creating one', () => {
    const state = makeGame({ players: ['a'] });

    assert.equal(tryCharge(state, 'ghost', 10), false);
    assert.equal(state.players.has('ghost'), false);
  });

  it('charges only the buyer, not the team', () => {
    // Wallets are per-player even though income is shared.
    const state = makeGame({ players: ['a', 'b'] });
    const bBefore = player(state, 'b').fish;

    tryCharge(state, 'a', 50);

    assert.equal(player(state, 'b').fish, bBefore);
  });
});

describe('refund', () => {
  it('returns fish to the player', () => {
    const state = makeGame({ players: ['a'] });
    const start = player(state, 'a').fish;

    tryCharge(state, 'a', 50);
    refund(state, 'a', 50);

    assert.equal(player(state, 'a').fish, start);
  });

  it('silently ignores an unknown player', () => {
    const state = makeGame({ players: ['a'] });
    assert.doesNotThrow(() => refund(state, 'ghost', 50));
    assert.equal(state.players.has('ghost'), false);
  });
});
