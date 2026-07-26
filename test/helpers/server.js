/**
 * Shared setup for server tests.
 *
 * Rooms take their clock, their randomness, and their transport as parameters, so
 * everything here is a plain object rather than a mock of something real. No sockets,
 * no timers, no sleeping.
 */

import { createLogger } from '../../src/logger.js';
import { createRoom } from '../../src/server/room.js';
import { createRoomRegistry } from '../../src/server/rooms.js';

/**
 * A logger that captures instead of writing, so a failing test can show what the
 * server thought was happening.
 *
 * @returns {import('../../src/logger.js').Logger & { lines: string[] }}
 */
export function silentLogger() {
  /** @type {string[]} */
  const lines = [];
  const logger = createLogger({
    level: 'debug',
    write: (line) => lines.push(line),
    now: () => '2026-07-26T00:00:00.000Z',
  });
  return Object.assign(logger, { lines });
}

/**
 * A connection that records everything sent to it.
 *
 * @param {string} id
 * @returns {{ id: string, send: (msg: any) => void, sent: any[], ofType: (type: string) => any[], last: (type: string) => any }}
 */
export function fakeConnection(id) {
  /** @type {any[]} */
  const sent = [];
  return {
    id,
    send: (msg) => sent.push(msg),
    sent,
    ofType: (type) => sent.filter((m) => m.type === type),
    last: (type) => {
      const matching = sent.filter((m) => m.type === type);
      return matching[matching.length - 1];
    },
  };
}

/**
 * Deterministic token source: seat-1, seat-2, ...
 *
 * @returns {() => string}
 */
export function sequentialTokens() {
  let n = 0;
  return () => {
    n += 1;
    return `seat-${n}`;
  };
}

/**
 * A room with predictable tokens and a captured log.
 *
 * @param {object} [options]
 * @param {string} [options.code]
 * @returns {{ room: import('../../src/server/room.js').Room, logger: ReturnType<typeof silentLogger> }}
 */
export function makeRoom({ code = 'BCDFG' } = {}) {
  const logger = silentLogger();
  const room = createRoom({ code, newToken: sequentialTokens(), logger });
  return { room, logger };
}

/**
 * A registry whose room codes are predictable.
 *
 * @param {object} [options]
 * @param {number} [options.idleMs]
 * @returns {{ rooms: import('../../src/server/rooms.js').RoomRegistry, logger: ReturnType<typeof silentLogger> }}
 */
export function makeRegistry({ idleMs } = {}) {
  const logger = silentLogger();
  let counter = 0;

  // Cycle the alphabet deterministically so successive rooms get distinct codes.
  const randomInt = (/** @type {number} */ max) => {
    counter += 1;
    return counter % max;
  };

  const rooms = createRoomRegistry({
    randomInt,
    newToken: sequentialTokens(),
    logger,
    ...(idleMs === undefined ? {} : { idleMs }),
  });
  return { rooms, logger };
}

/**
 * Seat a fresh connection in a room, asserting it worked.
 *
 * @param {import('../../src/server/room.js').Room} room
 * @param {string} id
 * @param {number} [nowMs]
 * @returns {{ conn: ReturnType<typeof fakeConnection>, join: import('../../src/server/room.js').JoinResult }}
 */
export function seat(room, id, nowMs = 0) {
  const conn = fakeConnection(id);
  const join = room.join(conn, undefined, nowMs);
  if (!join.ok) throw new Error(`expected ${id} to be seated: ${join.reason}`);
  return { conn, join };
}
