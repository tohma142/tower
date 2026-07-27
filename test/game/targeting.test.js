/**
 * Per-penguin targeting rules.
 *
 * Each rule is asserted against a hand-built set of enemies where the rules disagree —
 * a scenario where two priorities would pick the same enemy proves nothing. The default
 * is also pinned to the previous behaviour, because making targeting configurable must
 * not quietly retune the game.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyCommand } from '../../src/game/commands.js';
import { findTarget, spawnEnemy } from '../../src/game/enemies.js';
import { createTower } from '../../src/game/towers.js';
import {
  DEFAULT_TARGET_PRIORITY,
  TARGET_PRIORITY,
  TARGET_PRIORITY_IDS,
} from '../../src/shared/constants.js';
import { isBuildable, positionAt } from '../../src/shared/map.js';
import { REJECT_REASON } from '../../src/shared/protocol.js';
import { makeGame, player, rejection } from '../helpers/game.js';

const FREE_TILE = (() => {
  for (let x = 0; x < 20; x += 1) {
    for (let y = 0; y < 12; y += 1) {
      if (isBuildable(x, y)) return { x, y };
    }
  }
  throw new Error('no buildable tile on the map');
})();

/**
 * Three enemies along the path, arranged so every rule picks a different one.
 *
 * The origin sits on the path at progress 6, which puts the near enemy closest in space
 * while the far one is furthest along it — otherwise `first` and `closest` would agree
 * and the test would pass whichever rule was implemented.
 *
 * @returns {{ state: import('../../src/game/state.js').GameState, origin: { x: number, y: number }, ahead: any, behind: any, tough: any }}
 */
function scenario() {
  const state = makeGame();

  const behind = spawnEnemy(state, 'runner');
  behind.progress = 4;
  behind.hp = 5;

  const tough = spawnEnemy(state, 'brute');
  tough.progress = 6;
  tough.hp = 200;

  const ahead = spawnEnemy(state, 'walker');
  ahead.progress = 8;
  ahead.hp = 20;

  return { state, origin: positionAt(6), ahead, behind, tough };
}

/** Range wide enough that every enemy in the scenario qualifies. */
const WIDE = 1000 * 1000;

describe('findTarget — the rules disagree, and each picks its own', () => {
  it('first shoots whatever is closest to the iceberg', () => {
    const { state, origin, ahead } = scenario();

    assert.equal(findTarget(state.enemies, origin, WIDE, TARGET_PRIORITY.FIRST), ahead);
  });

  it('last shoots whatever just arrived', () => {
    const { state, origin, behind } = scenario();

    assert.equal(findTarget(state.enemies, origin, WIDE, TARGET_PRIORITY.LAST), behind);
  });

  it('strongest shoots the most health, not the most total health', () => {
    // Current hit points, not maximum: a nearly-dead Polar Bear should stop being the
    // priority target, or heavy damage keeps landing on something about to die anyway.
    const { state, origin, tough, ahead } = scenario();
    assert.equal(findTarget(state.enemies, origin, WIDE, TARGET_PRIORITY.STRONGEST), tough);

    tough.hp = 1;
    assert.equal(findTarget(state.enemies, origin, WIDE, TARGET_PRIORITY.STRONGEST), ahead);
  });

  it('closest shoots by distance, not by path position', () => {
    const { state, origin, tough } = scenario();

    // The origin sits exactly on the enemy at progress 6, so it wins on distance while
    // losing on "furthest along" — which is the whole point of offering the rule.
    assert.equal(findTarget(state.enemies, origin, WIDE, TARGET_PRIORITY.CLOSEST), tough);
  });
});

describe('findTarget — invariants every rule shares', () => {
  it('never picks an enemy out of range, whatever the rule', () => {
    // Far from the path rather than a tiny range at the origin: the scenario puts an
    // enemy exactly on the origin, so shrinking the range there would still find it.
    for (const priority of TARGET_PRIORITY_IDS) {
      const { state } = scenario();

      assert.equal(
        findTarget(state.enemies, { x: 500, y: 500 }, 3 * 3, priority),
        null,
        `${priority} reached outside its range`,
      );
    }
  });

  it('never picks a dead enemy, whatever the rule', () => {
    // Deaths are flagged and swept at the end of a tick, so a corpse is visible to
    // targeting in between. Shooting it would waste the shot.
    for (const priority of TARGET_PRIORITY_IDS) {
      const { state, origin } = scenario();
      for (const enemy of state.enemies) enemy.hp = 0;

      assert.equal(findTarget(state.enemies, origin, WIDE, priority), null, priority);
    }
  });

  it('returns null on an empty field, whatever the rule', () => {
    for (const priority of TARGET_PRIORITY_IDS) {
      assert.equal(findTarget([], { x: 0, y: 0 }, WIDE, priority), null, priority);
    }
  });

  it('falls back to the default rather than refusing to fire on an unknown rule', () => {
    // A newer client could name a rule this server has never heard of. A penguin that
    // silently stops shooting is far worse than one using the standard rule.
    const { state, origin, ahead } = scenario();

    assert.equal(findTarget(state.enemies, origin, WIDE, 'quantum'), ahead);
  });
});

describe('the default is the old behaviour', () => {
  it('is "first", so making targeting configurable retunes nothing', () => {
    assert.equal(DEFAULT_TARGET_PRIORITY, TARGET_PRIORITY.FIRST);
  });

  it('is what an unspecified call uses', () => {
    const { state, origin, ahead } = scenario();

    assert.equal(findTarget(state.enemies, origin, WIDE), ahead);
  });

  it('is what a freshly placed penguin gets', () => {
    const state = makeGame();
    const tower = createTower(state, {
      ownerId: 'p1',
      type: 'pistol',
      tileX: FREE_TILE.x,
      tileY: FREE_TILE.y,
    });

    assert.equal(tower.priority, DEFAULT_TARGET_PRIORITY);
  });
});

describe('setTarget — the command', () => {
  /**
   * @param {import('../../src/game/state.js').GameState} state
   * @param {string} playerId
   * @param {string} priority
   * @param {{ x: number, y: number }} [tile]
   */
  const setTarget = (state, playerId, priority, tile = FREE_TILE) =>
    applyCommand(state, playerId, {
      type: 'setTarget',
      tileX: tile.x,
      tileY: tile.y,
      priority,
    });

  /** @returns {import('../../src/game/state.js').GameState} */
  function gameWithTower(players = ['p1']) {
    const state = makeGame({ players });
    applyCommand(state, players[0], {
      type: 'place',
      tileX: FREE_TILE.x,
      tileY: FREE_TILE.y,
      towerType: 'pistol',
    });
    return state;
  }

  it('changes the rule the penguin actually fires by', () => {
    const state = gameWithTower();

    assert.equal(setTarget(state, 'p1', TARGET_PRIORITY.CLOSEST).ok, true);
    assert.equal(state.towers[0].priority, TARGET_PRIORITY.CLOSEST);
  });

  it('accepts every rule the protocol allows', () => {
    // A rule the wire accepts but the simulation refuses would be a dead button.
    for (const priority of TARGET_PRIORITY_IDS) {
      const state = gameWithTower();

      assert.equal(setTarget(state, 'p1', priority).ok, true, priority);
      assert.equal(state.towers[0].priority, priority);
    }
  });

  it('lets any player retarget any penguin, whoever paid for it', () => {
    // Towers belong to the team — they keep firing while their owner is disconnected.
    // A setting only one player could reach would be a co-op game fighting itself.
    const state = gameWithTower(['a', 'b']);

    assert.equal(setTarget(state, 'b', TARGET_PRIORITY.LAST).ok, true);
    assert.equal(state.towers[0].priority, TARGET_PRIORITY.LAST);
  });

  it('costs nothing', () => {
    const state = gameWithTower();
    const before = player(state, 'p1').fish;

    setTarget(state, 'p1', TARGET_PRIORITY.STRONGEST);

    assert.equal(player(state, 'p1').fish, before);
  });

  it('refuses a tile with no penguin on it', () => {
    const state = makeGame();

    assert.equal(
      rejection(setTarget(state, 'p1', TARGET_PRIORITY.LAST)),
      REJECT_REASON.NO_TOWER_HERE,
    );
  });

  it('refuses a tile off the board', () => {
    const state = gameWithTower();

    assert.equal(
      rejection(setTarget(state, 'p1', TARGET_PRIORITY.LAST, { x: -1, y: 0 })),
      REJECT_REASON.OUT_OF_BOUNDS,
    );
  });

  it('refuses someone who is not seated', () => {
    const state = gameWithTower();

    assert.equal(
      rejection(setTarget(state, 'ghost', TARGET_PRIORITY.LAST)),
      REJECT_REASON.NOT_A_PLAYER,
    );
  });
});
