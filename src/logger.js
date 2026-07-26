/**
 * Structured logging for the server.
 *
 * Emits one JSON object per line to stdout, which stays greppable and machine-readable
 * without pulling in a logging dependency. `console.log` is banned in `src/` because it
 * cannot be levelled, tagged, or filtered.
 *
 * Logging happens at boundaries — connection open/close, room lifecycle, wave start —
 * not on every line of game logic. A 20 Hz tick loop must never log per tick.
 */

import { LOG_LEVELS } from './config.js';

/** @typedef {import('./config.js').LogLevel} LogLevel */

/**
 * @typedef {object} Logger
 * @property {(msg: string, fields?: Record<string, unknown>) => void} debug
 * @property {(msg: string, fields?: Record<string, unknown>) => void} info
 * @property {(msg: string, fields?: Record<string, unknown>) => void} warn
 * @property {(msg: string, err?: unknown, fields?: Record<string, unknown>) => void} error
 * @property {(fields: Record<string, unknown>) => Logger} child
 */

/**
 * Reduce an unknown thrown value to something JSON-safe, preserving the stack and the
 * full `cause` chain so a wrapped error does not lose its origin.
 *
 * @param {unknown} err Whatever was thrown.
 * @returns {Record<string, unknown>} Serialisable representation.
 */
function serialiseError(err) {
  if (!(err instanceof Error)) return { value: String(err) };

  /** @type {Record<string, unknown>} */
  const out = { name: err.name, message: err.message, stack: err.stack };
  if (err.cause !== undefined) out.cause = serialiseError(err.cause);
  return out;
}

/**
 * Create a logger.
 *
 * @param {object} options
 * @param {LogLevel} options.level Minimum level to emit.
 * @param {(line: string) => void} [options.write] Sink for finished lines. Defaults to
 *   stdout; tests pass a collector so nothing is written to the real console.
 * @param {() => string} [options.now] Timestamp source, injected so tests stay deterministic.
 * @param {Record<string, unknown>} [options.base] Fields merged into every line.
 * @returns {Logger}
 */
export function createLogger({ level, write, now, base = {} }) {
  const threshold = LOG_LEVELS.indexOf(level);
  if (threshold === -1) {
    throw new TypeError(`unknown log level: ${level}`);
  }

  const sink = write ?? ((line) => process.stdout.write(`${line}\n`));
  const clock = now ?? (() => new Date().toISOString());

  /**
   * @param {LogLevel} lineLevel
   * @param {string} msg
   * @param {Record<string, unknown>} fields
   */
  function emit(lineLevel, msg, fields) {
    if (LOG_LEVELS.indexOf(lineLevel) < threshold) return;
    sink(JSON.stringify({ time: clock(), level: lineLevel, msg, ...base, ...fields }));
  }

  return {
    debug: (msg, fields = {}) => emit('debug', msg, fields),
    info: (msg, fields = {}) => emit('info', msg, fields),
    warn: (msg, fields = {}) => emit('warn', msg, fields),

    // The error object is a distinct parameter so the stack always survives — passing
    // it inside `fields` would stringify to "{}" and silently lose the trace.
    error: (msg, err, fields = {}) =>
      emit('error', msg, err === undefined ? fields : { ...fields, err: serialiseError(err) }),

    child: (fields) => createLogger({ level, write: sink, now: clock, base: { ...base, ...fields } }),
  };
}
