/**
 * Runtime configuration.
 *
 * Read and validated exactly once, at startup, by the entry point. Nothing else in
 * the codebase touches `process.env` — modules receive the frozen result instead.
 * A missing or malformed value crashes at boot naming the variable, rather than
 * surfacing as a mystery failure an hour later.
 */

/** @typedef {'debug' | 'info' | 'warn' | 'error'} LogLevel */

/**
 * @typedef {object} Config
 * @property {number} port      TCP port for the HTTP + WebSocket server.
 * @property {string} host      Interface to bind. 0.0.0.0 exposes the game to the LAN.
 * @property {LogLevel} logLevel Minimum level that gets written to stdout.
 */

/** @type {ReadonlyArray<LogLevel>} */
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

/**
 * Parse an environment value as a TCP port.
 *
 * @param {string | undefined} raw Value as read from the environment.
 * @param {number} fallback Value to use when `raw` is absent or empty.
 * @param {string} name Variable name, used in the error message.
 * @returns {number} A valid port number.
 * @throws {RangeError} If the value is present but not a port in 1..65535.
 */
function parsePort(raw, fallback, name) {
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new RangeError(`${name} must be an integer between 1 and 65535, got: ${raw}`);
  }
  return value;
}

/**
 * Build the frozen config object from an environment mapping.
 *
 * Takes the environment as a parameter rather than reading `process.env` directly so
 * that it stays a pure function: importing this module has no side effects, and tests
 * can pass a fake environment without mutating the real one.
 *
 * @param {Record<string, string | undefined>} [env] Environment to read from.
 * @returns {Readonly<Config>} Validated, immutable configuration.
 * @throws {RangeError} If PORT is malformed.
 * @throws {TypeError} If LOG_LEVEL is not a recognised level.
 */
export function loadConfig(env = {}) {
  const port = parsePort(env.PORT, 3000, 'PORT');
  const host = env.HOST === undefined || env.HOST === '' ? '127.0.0.1' : env.HOST;

  const rawLevel = env.LOG_LEVEL === undefined || env.LOG_LEVEL === '' ? 'info' : env.LOG_LEVEL;
  if (!LOG_LEVELS.includes(/** @type {LogLevel} */ (rawLevel))) {
    throw new TypeError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got: ${rawLevel}`);
  }

  return Object.freeze({
    port,
    host,
    logLevel: /** @type {LogLevel} */ (rawLevel),
  });
}

export { LOG_LEVELS };
