import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeEvent } from '../../src/client/render/hud.js';
import { REJECT_REASON } from '../../src/shared/protocol.js';

/**
 * Assert an event produced wording, and hand it back as a string.
 *
 * `describeEvent` returns null for events not worth showing, so every test that expects
 * a sentence goes through here rather than asserting against a possibly-null value.
 *
 * @param {any} event
 * @param {string | null} [playerId]
 * @returns {string}
 */
function line(event, playerId = null) {
  const text = describeEvent(event, playerId);
  assert.ok(typeof text === 'string', `expected wording for ${JSON.stringify(event)}`);
  return text;
}

describe('describeEvent', () => {
  it('announces a wave starting and clearing', () => {
    assert.match(line({ kind: 'waveStarted', wave: 4 }), /Wave 4/);
    assert.match(line({ kind: 'waveCleared', wave: 4 }), /Wave 4 cleared/);
  });

  it('reports a leak with what got through and what it cost', () => {
    const text = line({ kind: 'leak', enemyType: 'brute', damage: 10 });

    assert.match(text, /brute/);
    assert.match(text, /10/);
  });

  it('words victory and defeat differently, and names the wave lost on', () => {
    assert.match(line({ kind: 'gameOver', outcome: 'win', wave: 15 }), /win/i);

    const defeat = line({ kind: 'gameOver', outcome: 'loss', wave: 7 });
    assert.match(defeat, /Defeat/);
    assert.match(defeat, /7/);
  });

  it('has plain wording for every rejection reason', () => {
    // The player sees these. A raw constant like "tileNotBuildable" in the log leaks
    // internal vocabulary into the UI, so every reason gets a sentence.
    for (const reason of Object.values(REJECT_REASON)) {
      const text = line({ kind: 'commandRejected', reason }, 'p1');

      assert.ok(text.length > 0, `no wording for ${reason}`);
      assert.equal(text.includes(reason), false, `${reason} leaked its constant into the UI`);
    }
  });

  it('tells a spectator why they cannot build, in their own terms', () => {
    const asSpectator = line({ kind: 'commandRejected', reason: REJECT_REASON.NOT_A_PLAYER }, null);

    assert.match(asSpectator, /spectator/i);
  });

  it('still says something useful for an unrecognised reason', () => {
    // Forward compatibility: a newer server may refuse for a reason this client has
    // never heard of, and silence would be worse than an awkward sentence.
    assert.match(line({ kind: 'commandRejected', reason: 'somethingNew' }, 'p1'), /somethingNew/);
  });

  it('ignores events with nothing worth saying', () => {
    assert.equal(describeEvent({ kind: 'somethingInternal' }), null);
  });

  it('surfaces a protocol error rather than hiding it', () => {
    // A version mismatch should be visible, not a game that silently misbehaves.
    assert.match(line({ kind: 'protocolError', reason: 'tileX must be an integer' }), /tileX/);
  });
});
