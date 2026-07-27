/**
 * The wire protocol, and the boundary where untrusted input stops being untrusted.
 *
 * Every message arriving from a socket is validated here before any game code sees it.
 * Inward of this module, message shapes are trusted; outward of it, nothing is.
 *
 * Validation is a declarative spec table plus one generic checker, rather than a
 * `typeof` ladder per message or a schema library. A library would have to be vendored
 * or import-mapped to load unbundled in the browser — this file runs verbatim in both
 * runtimes — and the protocol is small enough that the table stays readable. If the
 * protocol grows a nested or recursive shape, revisit that trade.
 *
 * Rejections are deliberately specific about *which* field failed, because these
 * messages are the first thing anyone debugs when a client and server disagree.
 */

import {
  ENEMY_TYPE_IDS,
  GRID_COLS,
  GRID_ROWS,
  ROOM_CODE_LENGTH,
  TOWER_TYPE_IDS,
} from './constants.js';

/**
 * Client-to-server message types.
 * @readonly
 */
export const CLIENT_MSG = Object.freeze({
  /** First message on every connection: which room, and whether reclaiming a seat. */
  HELLO: 'hello',
  /** Buy and place a penguin. */
  PLACE: 'place',
  /** Spend fish to raise a placed penguin's level. */
  UPGRADE: 'upgrade',
  /** Remove a placed penguin, refunding part of what it cost. */
  SELL: 'sell',
  /** Toggle this player's ready state during the build phase. */
  READY: 'ready',
  /** From the game-over screen, return the room to the lobby. */
  PLAY_AGAIN: 'playAgain',
});

/**
 * Server-to-client message types.
 * @readonly
 */
export const SERVER_MSG = Object.freeze({
  /** Sent once on connect: seat identity, role, and the tuning tables. */
  WELCOME: 'welcome',
  /** The authoritative world, every tick. */
  SNAPSHOT: 'snapshot',
  /** Who is connected, seated, ready, and how much fish they hold. */
  ROSTER: 'roster',
  /** A discrete thing happened — a purchase was refused, a wave began, the game ended. */
  EVENT: 'event',
  /** The connection is being closed, with a reason worth showing the player. */
  REJECTED: 'rejected',
});

/**
 * Reasons a command can be refused. Callers branch on these constants; nothing anywhere
 * matches on the human-readable text, which is free to change.
 * @readonly
 */
export const REJECT_REASON = Object.freeze({
  INSUFFICIENT_FISH: 'insufficientFish',
  TILE_OCCUPIED: 'tileOccupied',
  TILE_NOT_BUILDABLE: 'tileNotBuildable',
  OUT_OF_BOUNDS: 'outOfBounds',
  WRONG_PHASE: 'wrongPhase',
  NOT_A_PLAYER: 'notAPlayer',
  UNKNOWN_TOWER_TYPE: 'unknownTowerType',
  NO_TOWER_HERE: 'noTowerHere',
  ALREADY_MAX_LEVEL: 'alreadyMaxLevel',
  ROOM_NOT_FOUND: 'roomNotFound',
  ROOM_FULL: 'roomFull',
});

/**
 * Field specifications.
 *
 * @typedef {{ kind: 'int', min: number, max: number }} IntSpec
 * @typedef {{ kind: 'bool' }} BoolSpec
 * @typedef {{ kind: 'enum', values: ReadonlyArray<string> }} EnumSpec
 * @typedef {{ kind: 'string', minLength: number, maxLength: number, pattern?: RegExp }} StringSpec
 * @typedef {{ kind: 'optional', inner: FieldSpec }} OptionalSpec
 * @typedef {IntSpec | BoolSpec | EnumSpec | StringSpec | OptionalSpec} FieldSpec
 */

/**
 * @param {number} min
 * @param {number} max
 * @returns {IntSpec}
 */
const int = (min, max) => ({ kind: 'int', min, max });

/** @returns {BoolSpec} */
const bool = () => ({ kind: 'bool' });

/**
 * @param {ReadonlyArray<string>} values
 * @returns {EnumSpec}
 */
const oneOf = (values) => ({ kind: 'enum', values });

/**
 * @param {number} minLength
 * @param {number} maxLength
 * @param {RegExp} [pattern]
 * @returns {StringSpec}
 */
const str = (minLength, maxLength, pattern) => ({ kind: 'string', minLength, maxLength, pattern });

/**
 * @param {FieldSpec} inner
 * @returns {OptionalSpec}
 */
const optional = (inner) => ({ kind: 'optional', inner });

/**
 * Room codes are uppercase letters and digits of a fixed length. Anchored, because an
 * unanchored pattern would accept a code with arbitrary text around it.
 */
const ROOM_CODE_PATTERN = new RegExp(`^[A-Z0-9]{${ROOM_CODE_LENGTH}}$`);

/** Seat tokens are `crypto.randomUUID()` output. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The complete set of messages a client may send. Anything not listed is rejected, and
 * any field not listed on a listed message is also rejected — an unknown field means the
 * two sides disagree about the protocol, which is worth failing loudly rather than
 * silently ignoring.
 *
 * @type {Readonly<Record<string, Readonly<Record<string, FieldSpec>>>>}
 */
export const CLIENT_MSG_SPEC = Object.freeze({
  [CLIENT_MSG.HELLO]: Object.freeze({
    // Absent means "make me a room". A player landing on `/` has no code yet; the
    // server allocates one and hands it back in the welcome, and the client rewrites
    // its URL to the shareable form.
    roomCode: optional(str(ROOM_CODE_LENGTH, ROOM_CODE_LENGTH, ROOM_CODE_PATTERN)),
    seatToken: optional(str(36, 36, UUID_PATTERN)),
  }),
  [CLIENT_MSG.PLACE]: Object.freeze({
    tileX: int(0, GRID_COLS - 1),
    tileY: int(0, GRID_ROWS - 1),
    towerType: oneOf(TOWER_TYPE_IDS),
  }),
  [CLIENT_MSG.UPGRADE]: Object.freeze({
    tileX: int(0, GRID_COLS - 1),
    tileY: int(0, GRID_ROWS - 1),
  }),
  [CLIENT_MSG.SELL]: Object.freeze({
    tileX: int(0, GRID_COLS - 1),
    tileY: int(0, GRID_ROWS - 1),
  }),
  [CLIENT_MSG.READY]: Object.freeze({
    value: bool(),
  }),
  [CLIENT_MSG.PLAY_AGAIN]: Object.freeze({}),
});

/**
 * @typedef {{ ok: true, value: { type: string } & Record<string, unknown> }} ValidOk
 * @typedef {{ ok: false, error: string }} ValidErr
 * @typedef {ValidOk | ValidErr} ValidationResult
 */

/**
 * Check one field against its spec.
 *
 * @param {string} name Field name, for the error message.
 * @param {unknown} value
 * @param {FieldSpec} spec
 * @returns {string | null} An error message, or null when the value is acceptable.
 */
function checkField(name, value, spec) {
  if (spec.kind === 'optional') {
    // Absent is fine; present-but-wrong is not. `null` counts as absent so a client can
    // send an explicit null rather than omitting the key.
    if (value === undefined || value === null) return null;
    return checkField(name, value, spec.inner);
  }

  switch (spec.kind) {
    case 'int':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return `${name} must be an integer`;
      }
      if (value < spec.min || value > spec.max) {
        return `${name} must be between ${spec.min} and ${spec.max}, got ${value}`;
      }
      return null;

    case 'bool':
      return typeof value === 'boolean' ? null : `${name} must be a boolean`;

    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        return `${name} must be one of: ${spec.values.join(', ')}`;
      }
      return null;

    case 'string':
      if (typeof value !== 'string') return `${name} must be a string`;
      if (value.length < spec.minLength || value.length > spec.maxLength) {
        return `${name} must be ${spec.minLength}..${spec.maxLength} characters, got ${value.length}`;
      }
      if (spec.pattern && !spec.pattern.test(value)) {
        return `${name} is malformed`;
      }
      return null;

    default:
      // Unreachable while FieldSpec stays exhaustive; a new kind that forgets a case
      // should fail closed rather than accept anything.
      return `${name} has an unsupported field spec`;
  }
}

/**
 * Validate a decoded client message.
 *
 * Takes the already-parsed value rather than a JSON string, so the caller controls how
 * much text it is willing to `JSON.parse` — capping that is the socket layer's job, and
 * doing it here would hide the limit from the place that enforces it.
 *
 * @param {unknown} msg A parsed JSON value from a client.
 * @returns {ValidationResult} On success, `value` is the message with only its specified
 *   fields, safe to hand to game code.
 */
export function validateClientMessage(msg) {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
    return { ok: false, error: 'message must be an object' };
  }

  const record = /** @type {Record<string, unknown>} */ (msg);
  const type = record.type;

  if (typeof type !== 'string') {
    return { ok: false, error: 'message type must be a string' };
  }

  const spec = Object.prototype.hasOwnProperty.call(CLIENT_MSG_SPEC, type)
    ? CLIENT_MSG_SPEC[type]
    : undefined;
  if (spec === undefined) {
    return { ok: false, error: `unknown message type: ${type}` };
  }

  // Unknown fields are an error, not something to ignore. A client sending a field the
  // server does not know about is a version mismatch, and failing here surfaces it at
  // the point of disagreement instead of as inexplicable behaviour three layers in.
  for (const key of Object.keys(record)) {
    if (key !== 'type' && !Object.prototype.hasOwnProperty.call(spec, key)) {
      return { ok: false, error: `unexpected field: ${key}` };
    }
  }

  /** @type {Record<string, unknown>} */
  const value = { type };

  for (const [name, fieldSpec] of Object.entries(spec)) {
    const error = checkField(name, record[name], fieldSpec);
    if (error !== null) return { ok: false, error };

    const raw = record[name];
    if (fieldSpec.kind === 'optional') {
      if (raw !== undefined && raw !== null) value[name] = raw;
    } else {
      value[name] = raw;
    }
  }

  return { ok: true, value: /** @type {{ type: string } & Record<string, unknown>} */ (value) };
}

/**
 * Enemy and tower type ids, re-exported so the client can render a legend without
 * importing the whole tuning table.
 */
export { ENEMY_TYPE_IDS, TOWER_TYPE_IDS };
