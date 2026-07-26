import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLogger } from '../src/logger.js';

/**
 * Build a logger writing into an array instead of stdout, with a frozen clock so
 * assertions never depend on wall-clock time.
 *
 * @param {import('../src/config.js').LogLevel} level
 * @returns {{ logger: import('../src/logger.js').Logger, lines: string[] }}
 */
function collectingLogger(level) {
  /** @type {string[]} */
  const lines = [];
  const logger = createLogger({
    level,
    write: (line) => lines.push(line),
    now: () => '2026-07-26T00:00:00.000Z',
  });
  return { logger, lines };
}

describe('createLogger', () => {
  it('emits one JSON object per line with level, message, and timestamp', () => {
    const { logger, lines } = collectingLogger('debug');

    logger.info('wave started', { wave: 3 });

    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      time: '2026-07-26T00:00:00.000Z',
      level: 'info',
      msg: 'wave started',
      wave: 3,
    });
  });

  it('suppresses levels below the threshold', () => {
    const { logger, lines } = collectingLogger('warn');

    logger.debug('noisy');
    logger.info('also noisy');
    logger.warn('kept');
    logger.error('kept too');

    assert.deepEqual(lines.map((l) => JSON.parse(l).level), ['warn', 'error']);
  });

  it('preserves the stack when logging an error', () => {
    const { logger, lines } = collectingLogger('debug');

    logger.error('purchase failed', new Error('insufficient fish'));

    const entry = JSON.parse(lines[0]);
    assert.equal(entry.err.name, 'Error');
    assert.equal(entry.err.message, 'insufficient fish');
    assert.match(entry.err.stack, /insufficient fish/);
  });

  it('preserves the full cause chain', () => {
    const { logger, lines } = collectingLogger('debug');
    const root = new Error('socket closed');

    logger.error('room tick failed', new Error('broadcast failed', { cause: root }));

    const entry = JSON.parse(lines[0]);
    assert.equal(entry.err.message, 'broadcast failed');
    assert.equal(entry.err.cause.message, 'socket closed');
  });

  it('does not throw when a non-Error value is thrown at it', () => {
    const { logger, lines } = collectingLogger('debug');

    logger.error('weird failure', 'just a string');

    assert.deepEqual(JSON.parse(lines[0]).err, { value: 'just a string' });
  });

  it('merges child fields into every line without mutating the parent', () => {
    const { logger, lines } = collectingLogger('debug');
    const roomLogger = logger.child({ room: 'BLUEFISH' });

    roomLogger.info('player joined', { seat: 2 });
    logger.info('unrelated');

    assert.equal(JSON.parse(lines[0]).room, 'BLUEFISH');
    assert.equal(JSON.parse(lines[0]).seat, 2);
    assert.equal(JSON.parse(lines[1]).room, undefined);
  });

  it('rejects an unknown level at construction rather than silently emitting nothing', () => {
    assert.throws(
      // @ts-expect-error — deliberately passing an invalid level.
      () => createLogger({ level: 'verbose' }),
      TypeError,
    );
  });
});
