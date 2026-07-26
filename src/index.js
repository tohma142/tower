/**
 * Entry point. The only module permitted import-time side effects.
 *
 * Reads and validates the environment once, builds the logger, wires the server, and
 * owns graceful shutdown. Everything downstream receives its dependencies as arguments
 * rather than reaching for globals — which is why every other module in this project is
 * testable without a running server.
 */

import { randomInt, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createRequestHandler } from './server/http.js';
import { createLoop } from './server/loop.js';
import { createRoomRegistry } from './server/rooms.js';
import { attachSocketServer } from './server/socket.js';
import { TICK_MS } from './shared/constants.js';

const config = loadConfig(process.env);
const logger = createLogger({ level: config.logLevel });

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const rooms = createRoomRegistry({
  randomInt: (max) => randomInt(max),
  newToken: () => randomUUID(),
  logger,
});

const server = createServer(createRequestHandler({ root: projectRoot, logger }));
const sockets = attachSocketServer({ server, rooms, logger, newId: () => randomUUID() });

const loop = createLoop({
  tickMs: TICK_MS,
  logger,
  onTick: (nowMs, dtMs) => {
    try {
      rooms.tickAll(nowMs, dtMs);
    } catch (err) {
      // One room throwing must not take down every other game on the server. Log it
      // with the stack intact and keep the loop running.
      logger.error('tick failed', err);
    }
  },
});

server.listen(config.port, config.host, () => {
  loop.start();
  logger.info('server listening', {
    url: `http://${config.host}:${config.port}`,
    tickHz: Math.round(1000 / TICK_MS),
    node: process.version,
  });
});

/**
 * Stop accepting work, drain what is in flight, release everything, exit.
 *
 * @param {string} signal
 * @returns {Promise<void>}
 */
async function shutdown(signal) {
  logger.info('shutting down', { signal, rooms: rooms.size });

  loop.stop();

  try {
    await sockets.close();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve(undefined)));
    });
  } catch (err) {
    logger.error('shutdown failed', err);
    process.exitCode = 1;
  }

  // In-memory rooms die with the process by design: no database, no stored state, no
  // recovery. Anyone mid-game loses it, which is the accepted cost of that choice.
  logger.info('stopped');
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

process.on('unhandledRejection', (reason) => {
  // Last-resort handler: log with the stack intact, then exit non-zero rather than
  // limping on in an unknown state. This is a crash handler, not error handling.
  logger.error('unhandled rejection', reason);
  process.exitCode = 1;
});
