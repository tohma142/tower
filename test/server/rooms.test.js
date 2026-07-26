import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRoomRegistry, generateRoomCode } from '../../src/server/rooms.js';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, TICK_MS } from '../../src/shared/constants.js';
import { fakeConnection, makeRegistry, silentLogger } from '../helpers/server.js';

describe('generateRoomCode', () => {
  it('produces a code of the agreed length', () => {
    assert.equal(generateRoomCode(() => 0).length, ROOM_CODE_LENGTH);
  });

  it('uses only characters from the alphabet', () => {
    for (let seed = 0; seed < 29; seed += 1) {
      const code = generateRoomCode((max) => (seed * 7) % max);
      for (const ch of code) {
        assert.ok(ROOM_CODE_ALPHABET.includes(ch), `unexpected character: ${ch}`);
      }
    }
  });

  it('excludes vowels and lookalike characters', () => {
    // Codes get read aloud and typed by hand, so O/0, I/1, and accidental words are
    // all worth designing out.
    for (const ch of 'AEIOU01') {
      assert.equal(ROOM_CODE_ALPHABET.includes(ch), false, `${ch} should not be in the alphabet`);
    }
  });

  it('matches the pattern the protocol validates against', () => {
    const pattern = new RegExp(`^[A-Z0-9]{${ROOM_CODE_LENGTH}}$`);
    for (let seed = 0; seed < 20; seed += 1) {
      assert.match(generateRoomCode((max) => (seed * 13 + 5) % max), pattern);
    }
  });
});

describe('registry', () => {
  it('creates rooms with distinct codes', () => {
    const { rooms } = makeRegistry();
    const a = rooms.create();
    const b = rooms.create();

    assert.notEqual(a.code, b.code);
    assert.equal(rooms.size, 2);
  });

  it('finds a room by its code', () => {
    const { rooms } = makeRegistry();
    const room = rooms.create();

    assert.equal(rooms.get(room.code), room);
    assert.equal(rooms.has(room.code), true);
  });

  it('returns undefined for an unknown code rather than creating one', () => {
    const { rooms } = makeRegistry();

    assert.equal(rooms.get('ZZZZZ'), undefined);
    assert.equal(rooms.size, 0);
  });

  it('retries when a generated code collides', () => {
    // A fixed randomness source would hand out the same code forever.
    const logger = silentLogger();
    let calls = 0;
    const rooms = createRoomRegistry({
      // First room gets all-zeros; after that, advance so the second differs.
      randomInt: () => {
        calls += 1;
        return calls <= ROOM_CODE_LENGTH ? 0 : 1;
      },
      newToken: () => 'token',
      logger,
    });

    const a = rooms.create();
    const b = rooms.create();

    assert.notEqual(a.code, b.code);
  });

  it('gives up loudly rather than looping forever when codes are exhausted', () => {
    // An infinite retry loop here would take the whole server down with it.
    const logger = silentLogger();
    const rooms = createRoomRegistry({
      randomInt: () => 0, // always the same code
      newToken: () => 'token',
      logger,
    });

    rooms.create();
    assert.throws(() => rooms.create(), /could not allocate a free room code/);
  });

  it('keeps rooms isolated from one another', () => {
    const { rooms } = makeRegistry();
    const a = rooms.create();
    const b = rooms.create();

    a.join(fakeConnection('c1'), undefined, 0);

    assert.equal(a.seatCount, 1);
    assert.equal(b.seatCount, 0, 'a player in one room must not appear in another');
  });
});

describe('tickAll', () => {
  it('advances every room', () => {
    const { rooms } = makeRegistry();
    const a = rooms.create();
    const b = rooms.create();
    a.join(fakeConnection('c1'), undefined, 0);
    b.join(fakeConnection('c2'), undefined, 0);

    rooms.tickAll(0, TICK_MS);

    assert.equal(a.state.tickCount, 1);
    assert.equal(b.state.tickCount, 1);
  });

  it('destroys a room once it has been empty long enough', () => {
    const { rooms } = makeRegistry({ idleMs: 1000 });
    const room = rooms.create();
    room.join(fakeConnection('c1'), undefined, 0);
    rooms.tickAll(0, TICK_MS);

    room.disconnect('c1', 100);

    rooms.tickAll(1099, TICK_MS);
    assert.equal(rooms.size, 1, 'not yet');

    rooms.tickAll(1100, TICK_MS);
    assert.equal(rooms.size, 0, 'the game ceases to exist; there is nowhere it was stored');
  });

  it('keeps an occupied room alive indefinitely', () => {
    const { rooms } = makeRegistry({ idleMs: 1000 });
    const room = rooms.create();
    room.join(fakeConnection('c1'), undefined, 0);

    for (let i = 0; i < 200; i += 1) rooms.tickAll(i * 1000, TICK_MS);

    assert.equal(rooms.size, 1);
  });

  it('still gives a room that emptied this tick its final step', () => {
    const { rooms } = makeRegistry({ idleMs: 0 });
    const room = rooms.create();
    room.join(fakeConnection('c1'), undefined, 0);
    room.disconnect('c1', 0);

    rooms.tickAll(0, TICK_MS);

    assert.equal(room.state.tickCount, 1, 'ticked before being swept');
    assert.equal(rooms.size, 0);
  });
});
