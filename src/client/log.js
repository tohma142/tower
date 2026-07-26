/**
 * Browser-side logging.
 *
 * The one module in `src/` allowed to touch `console` — everything else goes through
 * here so client output stays levelled and filterable, mirroring the server logger.
 * Defaults to `warn` so a normal session is quiet; flip it by appending `?log=debug`
 * to the URL when you need to see the network and render chatter.
 */

/** @typedef {'debug' | 'info' | 'warn' | 'error'} LogLevel */

/** @type {ReadonlyArray<LogLevel>} */
const LEVELS = ['debug', 'info', 'warn', 'error'];

/** @type {LogLevel} */
let current = 'warn';

/**
 * Set the minimum level that reaches the console.
 *
 * @param {string | null | undefined} level Level name; unknown values are ignored so a
 *   typo in the query string cannot silence logging entirely.
 * @returns {LogLevel} The level now in effect.
 */
export function setLogLevel(level) {
  if (level != null && LEVELS.includes(/** @type {LogLevel} */ (level))) {
    current = /** @type {LogLevel} */ (level);
  }
  return current;
}

/**
 * @param {LogLevel} level
 * @returns {boolean} Whether this level is currently emitted.
 */
function enabled(level) {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(current);
}

export const log = {
  /** @param {...unknown} args */
  debug: (...args) => { if (enabled('debug')) console.debug('[tower]', ...args); },
  /** @param {...unknown} args */
  info: (...args) => { if (enabled('info')) console.info('[tower]', ...args); },
  /** @param {...unknown} args */
  warn: (...args) => { if (enabled('warn')) console.warn('[tower]', ...args); },
  /** @param {...unknown} args */
  error: (...args) => { if (enabled('error')) console.error('[tower]', ...args); },
};
