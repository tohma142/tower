/**
 * Entry point. The only module permitted import-time side effects.
 *
 * Reads and validates the environment once, builds the logger, starts the server, and
 * owns graceful shutdown. Everything downstream receives config and logger as arguments
 * rather than reaching for globals.
 */

import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const config = loadConfig(process.env);
const logger = createLogger({ level: config.logLevel });

logger.info('server starting', { host: config.host, port: config.port, node: process.version });

// TODO(step 4): start the HTTP + WebSocket server and register SIGTERM/SIGINT draining.
logger.warn('server not implemented yet — scaffold only');

process.on('unhandledRejection', (reason) => {
  // Last-resort handler: log with the stack intact, then exit non-zero rather than
  // limping on in an unknown state. This is a crash handler, not error handling.
  logger.error('unhandled rejection', reason);
  process.exitCode = 1;
});
