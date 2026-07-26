import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GRID_COLS, GRID_ROWS } from '../../src/shared/constants.js';
import { CLIENT_MSG, validateClientMessage } from '../../src/shared/protocol.js';

/**
 * Assert a message is rejected, and that the error names the offending field — the
 * error text is the first thing anyone reads when a client and server disagree.
 *
 * @param {unknown} msg
 * @param {RegExp} matching
 */
function rejects(msg, matching) {
  const result = validateClientMessage(msg);
  assert.equal(result.ok, false, `expected rejection of ${JSON.stringify(msg)}`);
  assert.match(result.error, matching);
}

/**
 * @param {unknown} msg
 * @returns {Record<string, unknown>}
 */
function accepts(msg) {
  const result = validateClientMessage(msg);
  assert.equal(result.ok, true, `expected acceptance, got: ${result.ok ? '' : result.error}`);
  return result.value;
}

describe('validateClientMessage — envelope', () => {
  it('rejects non-objects', () => {
    rejects('place', /must be an object/);
    rejects(42, /must be an object/);
    rejects(null, /must be an object/);
    rejects(undefined, /must be an object/);
  });

  it('rejects arrays, which are objects but not messages', () => {
    rejects([{ type: 'ready', value: true }], /must be an object/);
  });

  it('rejects a missing or non-string type', () => {
    rejects({}, /type must be a string/);
    rejects({ type: 7 }, /type must be a string/);
  });

  it('rejects an unknown message type by name', () => {
    rejects({ type: 'selfDestruct' }, /unknown message type: selfDestruct/);
  });

  it('does not treat inherited Object properties as a message type', () => {
    // `{}.constructor` is truthy; a hasOwnProperty-free lookup would resolve
    // `CLIENT_MSG_SPEC['constructor']` and try to validate against a function.
    rejects({ type: 'constructor' }, /unknown message type/);
    rejects({ type: 'toString' }, /unknown message type/);
    rejects({ type: '__proto__' }, /unknown message type/);
  });
});

describe('validateClientMessage — place', () => {
  it('accepts a well-formed placement', () => {
    const value = accepts({ type: CLIENT_MSG.PLACE, tileX: 3, tileY: 4, towerType: 'sniper' });
    assert.deepEqual(value, { type: 'place', tileX: 3, tileY: 4, towerType: 'sniper' });
  });

  it('accepts the extreme corners of the board', () => {
    accepts({ type: CLIENT_MSG.PLACE, tileX: 0, tileY: 0, towerType: 'pistol' });
    accepts({ type: CLIENT_MSG.PLACE, tileX: GRID_COLS - 1, tileY: GRID_ROWS - 1, towerType: 'pistol' });
  });

  it('rejects coordinates one step outside the board', () => {
    rejects({ type: CLIENT_MSG.PLACE, tileX: -1, tileY: 0, towerType: 'pistol' }, /tileX/);
    rejects({ type: CLIENT_MSG.PLACE, tileX: GRID_COLS, tileY: 0, towerType: 'pistol' }, /tileX/);
    rejects({ type: CLIENT_MSG.PLACE, tileX: 0, tileY: -1, towerType: 'pistol' }, /tileY/);
    rejects({ type: CLIENT_MSG.PLACE, tileX: 0, tileY: GRID_ROWS, towerType: 'pistol' }, /tileY/);
  });

  it('rejects non-integer coordinates', () => {
    rejects({ type: CLIENT_MSG.PLACE, tileX: 1.5, tileY: 2, towerType: 'pistol' }, /tileX must be an integer/);
    rejects({ type: CLIENT_MSG.PLACE, tileX: NaN, tileY: 2, towerType: 'pistol' }, /tileX must be an integer/);
    rejects({ type: CLIENT_MSG.PLACE, tileX: Infinity, tileY: 2, towerType: 'pistol' }, /tileX must be an integer/);
  });

  it('rejects coordinates sent as numeric strings', () => {
    // JSON keeps the distinction, so a string here means the client is wrong.
    rejects({ type: CLIENT_MSG.PLACE, tileX: '3', tileY: 4, towerType: 'pistol' }, /tileX must be an integer/);
  });

  it('rejects an unknown tower type and lists the valid ones', () => {
    rejects({ type: CLIENT_MSG.PLACE, tileX: 1, tileY: 1, towerType: 'bazooka' }, /towerType must be one of/);
  });

  it('rejects a missing required field', () => {
    rejects({ type: CLIENT_MSG.PLACE, tileX: 1, tileY: 1 }, /towerType/);
    rejects({ type: CLIENT_MSG.PLACE, towerType: 'pistol' }, /tileX/);
  });

  it('rejects unexpected fields rather than ignoring them', () => {
    // An unknown field means the two sides disagree about the protocol. Silently
    // dropping it hides a version mismatch until it causes something inexplicable.
    rejects(
      { type: CLIENT_MSG.PLACE, tileX: 1, tileY: 1, towerType: 'pistol', free: true },
      /unexpected field: free/,
    );
  });
});

describe('validateClientMessage — hello', () => {
  it('accepts a room code alone', () => {
    const value = accepts({ type: CLIENT_MSG.HELLO, roomCode: 'BCDFG' });
    assert.deepEqual(value, { type: 'hello', roomCode: 'BCDFG' });
  });

  it('accepts a room code with a seat token for reconnecting', () => {
    const token = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const value = accepts({ type: CLIENT_MSG.HELLO, roomCode: 'BCDFG', seatToken: token });
    assert.equal(value.seatToken, token);
  });

  it('treats an explicit null seat token as absent', () => {
    // A fresh client may send `seatToken: sessionStorage.getItem(...)`, which is null.
    const value = accepts({ type: CLIENT_MSG.HELLO, roomCode: 'BCDFG', seatToken: null });
    assert.ok(!('seatToken' in value));
  });

  it('rejects a malformed room code', () => {
    rejects({ type: CLIENT_MSG.HELLO, roomCode: 'abcde' }, /roomCode is malformed/);
    rejects({ type: CLIENT_MSG.HELLO, roomCode: 'BCD-G' }, /roomCode is malformed/);
  });

  it('rejects a room code of the wrong length', () => {
    rejects({ type: CLIENT_MSG.HELLO, roomCode: 'BCD' }, /roomCode must be/);
    rejects({ type: CLIENT_MSG.HELLO, roomCode: 'BCDFGHJ' }, /roomCode must be/);
  });

  it('rejects a seat token that is present but not a UUID', () => {
    rejects({ type: CLIENT_MSG.HELLO, roomCode: 'BCDFG', seatToken: 'x'.repeat(36) }, /seatToken is malformed/);
    rejects({ type: CLIENT_MSG.HELLO, roomCode: 'BCDFG', seatToken: 'short' }, /seatToken must be/);
  });
});

describe('validateClientMessage — ready and playAgain', () => {
  it('accepts both ready states', () => {
    assert.deepEqual(accepts({ type: CLIENT_MSG.READY, value: true }), { type: 'ready', value: true });
    assert.deepEqual(accepts({ type: CLIENT_MSG.READY, value: false }), { type: 'ready', value: false });
  });

  it('rejects truthy stand-ins for a boolean', () => {
    rejects({ type: CLIENT_MSG.READY, value: 1 }, /value must be a boolean/);
    rejects({ type: CLIENT_MSG.READY, value: 'true' }, /value must be a boolean/);
  });

  it('accepts playAgain, which carries no fields', () => {
    assert.deepEqual(accepts({ type: CLIENT_MSG.PLAY_AGAIN }), { type: 'playAgain' });
  });

  it('rejects fields on a message that takes none', () => {
    rejects({ type: CLIENT_MSG.PLAY_AGAIN, wave: 1 }, /unexpected field: wave/);
  });
});

describe('validateClientMessage — output safety', () => {
  it('returns a fresh object rather than the caller-supplied one', () => {
    // Game code holds onto validated messages. Returning the original would let a
    // caller mutate it, and would carry any non-enumerable extras along with it.
    const input = { type: CLIENT_MSG.READY, value: true };
    const value = accepts(input);
    assert.notEqual(value, input);
  });

  it('copies through only fields named in the spec', () => {
    const value = accepts({ type: CLIENT_MSG.PLACE, tileX: 2, tileY: 2, towerType: 'bomber' });
    assert.deepEqual(Object.keys(value).sort(), ['tileX', 'tileY', 'towerType', 'type']);
  });
});
