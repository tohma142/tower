import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyCommand } from '../../src/game/commands.js';
import { startWave } from '../../src/game/state.js';
import { PHASE, TOWER_TYPES } from '../../src/shared/constants.js';
import { PATH_WAYPOINTS, isBuildable } from '../../src/shared/map.js';
import { REJECT_REASON } from '../../src/shared/protocol.js';
import { grantFish, makeGame, player, rejection } from '../helpers/game.js';

/** A tile that is definitely buildable, found rather than assumed. */
const FREE_TILE = (() => {
  for (let x = 0; x < 20; x += 1) {
    for (let y = 0; y < 12; y += 1) {
      if (isBuildable(x, y)) return { x, y };
    }
  }
  throw new Error('no buildable tile on the map');
})();

/**
 * @param {import('../../src/game/state.js').GameState} state
 * @param {string} player
 * @param {number} tileX
 * @param {number} tileY
 * @param {string} [towerType]
 */
function place(state, player, tileX, tileY, towerType = 'pistol') {
  return applyCommand(state, player, { type: 'place', tileX, tileY, towerType });
}

describe('place — success', () => {
  it('charges the buyer exactly the tower cost, once', () => {
    const state = makeGame();
    const before = player(state, 'p1').fish;

    const result = place(state, 'p1', FREE_TILE.x, FREE_TILE.y, 'pistol');

    assert.equal(result.ok, true);
    assert.equal(player(state, 'p1').fish, before - TOWER_TYPES.pistol.cost);
    assert.equal(state.towers.length, 1);
  });

  it('charges only the buyer, not the whole team', () => {
    const state = makeGame({ players: ['a', 'b'] });
    const bBefore = player(state, 'b').fish;

    place(state, 'a', FREE_TILE.x, FREE_TILE.y);

    assert.equal(player(state, 'b').fish, bBefore);
  });

  it('records the tile as occupied', () => {
    const state = makeGame();
    place(state, 'p1', FREE_TILE.x, FREE_TILE.y);

    assert.equal(state.occupancy.size, 1);
  });

  it('allows building during a wave, not just the build phase', () => {
    // Reacting to a wave going badly is core play; forbidding it would make the build
    // phase the only decision point in the game.
    const state = makeGame();
    grantFish(state, 'p1');
    startWave(state);
    assert.equal(state.phase, PHASE.WAVE);

    assert.equal(place(state, 'p1', FREE_TILE.x, FREE_TILE.y).ok, true);
  });
});

describe('place — rejections', () => {
  it('rejects a player who is not in the game', () => {
    const state = makeGame();
    const result = place(state, 'spectator', FREE_TILE.x, FREE_TILE.y);

    assert.deepEqual(result, { ok: false, reason: REJECT_REASON.NOT_A_PLAYER });
    assert.equal(state.towers.length, 0);
  });

  it('rejects placement in the lobby', () => {
    const state = makeGame();
    state.phase = PHASE.LOBBY;

    assert.equal(rejection(place(state, 'p1', FREE_TILE.x, FREE_TILE.y)), REJECT_REASON.WRONG_PHASE);
  });

  it('rejects placement after the game is over', () => {
    const state = makeGame();
    state.phase = PHASE.GAME_OVER;

    assert.equal(rejection(place(state, 'p1', FREE_TILE.x, FREE_TILE.y)), REJECT_REASON.WRONG_PHASE);
  });

  it('rejects an unknown tower type', () => {
    const state = makeGame();
    const result = place(state, 'p1', FREE_TILE.x, FREE_TILE.y, 'bazooka');

    assert.equal(rejection(result), REJECT_REASON.UNKNOWN_TOWER_TYPE);
  });

  it('rejects tiles off the board', () => {
    const state = makeGame();
    assert.equal(rejection(place(state, 'p1', -1, 0)), REJECT_REASON.OUT_OF_BOUNDS);
    assert.equal(rejection(place(state, 'p1', 999, 0)), REJECT_REASON.OUT_OF_BOUNDS);
  });

  it('rejects fractional tiles', () => {
    // Protocol validation should stop these, but a float here would key an occupancy
    // map nothing can match, allowing unlimited stacking on one tile.
    const state = makeGame();
    assert.equal(rejection(place(state, 'p1', 1.5, 2)), REJECT_REASON.OUT_OF_BOUNDS);
  });

  it('rejects tiles the enemies walk over', () => {
    const state = makeGame();
    const onPath = PATH_WAYPOINTS[1];

    const result = place(state, 'p1', onPath.x, onPath.y);

    assert.equal(rejection(result), REJECT_REASON.TILE_NOT_BUILDABLE);
    assert.equal(state.towers.length, 0);
  });

  it('rejects a tile that already has a penguin on it', () => {
    const state = makeGame();
    grantFish(state, 'p1');
    place(state, 'p1', FREE_TILE.x, FREE_TILE.y);

    const result = place(state, 'p1', FREE_TILE.x, FREE_TILE.y);

    assert.equal(rejection(result), REJECT_REASON.TILE_OCCUPIED);
    assert.equal(state.towers.length, 1);
  });

  it('rejects a purchase the player cannot afford, and charges nothing', () => {
    const state = makeGame();
    player(state, 'p1').fish = TOWER_TYPES.sniper.cost - 1;

    const result = place(state, 'p1', FREE_TILE.x, FREE_TILE.y, 'sniper');

    assert.equal(rejection(result), REJECT_REASON.INSUFFICIENT_FISH);
    assert.equal(player(state, 'p1').fish, TOWER_TYPES.sniper.cost - 1, 'no partial debit');
    assert.equal(state.towers.length, 0);
  });

  it('reports the board problem before the money problem', () => {
    // Telling someone they cannot afford a tile that was never buildable is misleading.
    const state = makeGame();
    player(state, 'p1').fish = 0;
    const onPath = PATH_WAYPOINTS[1];

    assert.equal(rejection(place(state, 'p1', onPath.x, onPath.y)), REJECT_REASON.TILE_NOT_BUILDABLE);
  });
});

describe('place — same-tick contention between players', () => {
  it('gives the tile to whoever is applied first and rejects the second', () => {
    // Commands queue on arrival and apply in order at the start of a tick, so this
    // outcome is deterministic rather than a race.
    const state = makeGame({ players: ['a', 'b'] });
    const aBefore = player(state, 'a').fish;
    const bBefore = player(state, 'b').fish;

    const first = place(state, 'a', FREE_TILE.x, FREE_TILE.y);
    const second = place(state, 'b', FREE_TILE.x, FREE_TILE.y);

    assert.equal(first.ok, true);
    assert.equal(rejection(second), REJECT_REASON.TILE_OCCUPIED);
    assert.equal(state.towers.length, 1);
    assert.equal(state.towers[0].ownerId, 'a');

    assert.equal(player(state, 'a').fish, aBefore - TOWER_TYPES.pistol.cost);
    assert.equal(player(state, 'b').fish, bBefore, 'the loser must not be charged');
  });

  it('produces the same result whichever order the two arrive in', () => {
    const state = makeGame({ players: ['a', 'b'] });
    place(state, 'b', FREE_TILE.x, FREE_TILE.y);
    const loser = place(state, 'a', FREE_TILE.x, FREE_TILE.y);

    assert.equal(rejection(loser), REJECT_REASON.TILE_OCCUPIED);
    assert.equal(state.towers[0].ownerId, 'b');
  });
});

describe('ready', () => {
  it('sets and clears the flag during the build phase', () => {
    const state = makeGame();

    assert.equal(applyCommand(state, 'p1', { type: 'ready', value: true }).ok, true);
    assert.equal(player(state, 'p1').ready, true);

    applyCommand(state, 'p1', { type: 'ready', value: false });
    assert.equal(player(state, 'p1').ready, false);
  });

  it('refuses to arm the next wave from a stale click during a wave', () => {
    const state = makeGame();
    startWave(state);

    const result = applyCommand(state, 'p1', { type: 'ready', value: true });

    assert.equal(rejection(result), REJECT_REASON.WRONG_PHASE);
    assert.equal(player(state, 'p1').ready, false);
  });

  it('rejects an unknown player', () => {
    const state = makeGame();
    const result = applyCommand(state, 'ghost', { type: 'ready', value: true });

    assert.equal(rejection(result), REJECT_REASON.NOT_A_PLAYER);
  });
});

describe('applyCommand', () => {
  it('reports an unhandled command type rather than silently ignoring it', () => {
    const state = makeGame();
    const result = applyCommand(state, 'p1', { type: 'playAgain' });

    assert.equal(result.ok, false);
    assert.match(rejection(result), /unhandled command/);
  });
});
