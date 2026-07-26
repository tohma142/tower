/**
 * The room registry: creating rooms, finding them by code, and destroying them when
 * everyone has gone.
 *
 * This is the whole of the game's persistence story. A room lives in this Map and
 * nowhere else — no database, no disk, no recovery. When the last connection drops and
 * the grace period passes, the game ceases to exist. That is a deliberate consequence
 * of "no stored state", not an oversight.
 */

import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, ROOM_EMPTY_GC_MS } from '../shared/constants.js';

import { createRoom } from './room.js';

/**
 * Build a room code from an injected randomness source.
 *
 * The alphabet excludes vowels and the 0/O and 1/I lookalikes, because these codes get
 * read aloud and typed by hand.
 *
 * @param {(max: number) => number} randomInt Returns an integer in [0, max).
 * @returns {string}
 */
export function generateRoomCode(randomInt) {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Create the registry.
 *
 * Both randomness sources are injected rather than imported, so tests can produce
 * predictable codes and tokens without stubbing globals.
 *
 * @param {object} options
 * @param {(max: number) => number} options.randomInt
 * @param {() => string} options.newToken
 * @param {import('../logger.js').Logger} options.logger
 * @param {number} [options.idleMs] How long an empty room survives.
 */
export function createRoomRegistry({ randomInt, newToken, logger, idleMs = ROOM_EMPTY_GC_MS }) {
  /** @type {Map<string, import('./room.js').Room>} */
  const rooms = new Map();

  /**
   * Allocate an unused room code.
   *
   * Retries on collision and gives up loudly rather than looping forever: with a 29
   * character alphabet over 5 places, exhausting the space means something is very
   * wrong, and an infinite loop would take the server with it.
   *
   * @returns {string}
   * @throws {Error} If no free code is found.
   */
  function allocateCode() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const code = generateRoomCode(randomInt);
      if (!rooms.has(code)) return code;
    }
    throw new Error(`could not allocate a free room code after 100 attempts (${rooms.size} rooms)`);
  }

  return {
    /**
     * @returns {import('./room.js').Room} A new, empty room.
     */
    create() {
      const code = allocateCode();
      const room = createRoom({ code, newToken, logger });
      rooms.set(code, room);
      logger.info('room created', { room: code, rooms: rooms.size });
      return room;
    },

    /**
     * @param {string} code
     * @returns {import('./room.js').Room | undefined}
     */
    get(code) {
      return rooms.get(code);
    },

    /**
     * @param {string} code
     * @returns {boolean}
     */
    has(code) {
      return rooms.has(code);
    },

    /** @returns {number} */
    get size() {
      return rooms.size;
    },

    /** @returns {IterableIterator<import('./room.js').Room>} */
    values() {
      return rooms.values();
    },

    /**
     * Advance every room, then destroy any that have been empty long enough.
     *
     * Sweeping after ticking means a room that emptied this tick still gets its final
     * step, which keeps the two concerns from interleaving confusingly.
     *
     * @param {number} nowMs
     * @param {number} dtMs
     * @returns {void}
     */
    tickAll(nowMs, dtMs) {
      for (const room of rooms.values()) {
        room.tick(nowMs, dtMs);
      }

      for (const [code, room] of rooms) {
        if (room.isExpired(nowMs, idleMs)) {
          rooms.delete(code);
          logger.info('room destroyed', { room: code, rooms: rooms.size });
        }
      }
    },
  };
}

/** @typedef {ReturnType<typeof createRoomRegistry>} RoomRegistry */
