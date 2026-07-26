/**
 * Static file serving.
 *
 * There is no build step: `src/client` and `src/shared` are served to the browser as
 * plain ES modules, exactly as they sit on disk. That is why the URL space mirrors the
 * source tree — a relative import in a shared module resolves identically in Node and
 * in the browser only because the paths line up.
 *
 * Serving files straight from disk in response to a URL is the classic place to leak a
 * filesystem, so every request is resolved to an absolute path and checked against the
 * served root before anything is opened. There are tests for `../`, for its encoded
 * forms, and for absolute paths.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

/**
 * Extensions we are willing to serve, and what to call them.
 *
 * An allow-list rather than a deny-list: anything not named here is a 404, so a stray
 * `.env`, `.pem`, or editor backup in the tree can never be fetched even if the path
 * check somehow passed.
 */
/** @type {Readonly<Record<string, string>>} */
const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
});

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} body
 * @returns {void}
 */
function sendText(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Resolve a URL path to a file inside the served root, or reject it.
 *
 * @param {string} root Absolute path to the directory being served.
 * @param {string} urlPath The URL's pathname, still percent-encoded.
 * @returns {string | null} An absolute path inside `root`, or null if the request is
 *   malformed or tries to escape.
 */
export function resolveWithinRoot(root, urlPath) {
  /** @type {string} */
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    // Malformed percent-encoding. Refusing is right: a decoder that guesses is a
    // decoder that eventually guesses its way past the check below.
    return null;
  }

  // A null byte can truncate a path inside a C-level API, making "/safe.js\0/../../etc"
  // look benign to a JavaScript string check.
  if (decoded.includes('\0')) return null;

  // Strip the leading slash so this always resolves *relative* to root. Without it, an
  // absolute-looking path would replace root entirely.
  const relative = decoded.replace(/^\/+/, '');
  const resolved = path.resolve(root, relative);

  // The separator matters: without it, a sibling directory whose name merely starts
  // with the root's name ("/srv/app-secrets" against root "/srv/app") would pass.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;

  return resolved;
}

/**
 * Build the HTTP request handler.
 *
 * @param {object} options
 * @param {string} options.root Absolute path to the project root; `src/` under it is served.
 * @param {import('../logger.js').Logger} options.logger
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createRequestHandler({ root, logger }) {
  const srcRoot = path.resolve(root, 'src');
  const indexPath = path.join(srcRoot, 'client', 'index.html');

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {string} filePath
   * @returns {Promise<void>}
   */
  async function sendFile(res, filePath) {
    const type = CONTENT_TYPES[path.extname(filePath).toLowerCase()];
    if (type === undefined) {
      sendText(res, 404, 'Not found');
      return;
    }

    /** @type {import('node:fs').Stats} */
    let stats;
    try {
      stats = await stat(filePath);
    } catch {
      sendText(res, 404, 'Not found');
      return;
    }

    if (!stats.isFile()) {
      sendText(res, 404, 'Not found');
      return;
    }

    res.writeHead(200, {
      'content-type': type,
      'content-length': stats.size,
      // The client is served unbundled and edited live during development; a cached
      // module is a confusing way to spend ten minutes.
      'cache-control': 'no-cache',
    });

    // Streamed rather than buffered, so a large asset never sits in memory whole.
    await pipeline(createReadStream(filePath), res);
  }

  return async function handleRequest(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    try {
      // The lobby and every room URL serve the same page; the client reads the room
      // code out of its own location. This is what makes /r/BCDFG shareable.
      if (pathname === '/' || /^\/r\/[A-Z0-9]+\/?$/.test(pathname)) {
        await sendFile(res, indexPath);
        return;
      }

      if (pathname.startsWith('/src/')) {
        const resolved = resolveWithinRoot(srcRoot, pathname.slice('/src'.length));
        if (resolved === null) {
          logger.warn('rejected path traversal attempt', { path: pathname });
          sendText(res, 403, 'Forbidden');
          return;
        }
        await sendFile(res, resolved);
        return;
      }

      sendText(res, 404, 'Not found');
    } catch (err) {
      // A client that disappears mid-response aborts the stream. That is normal, not
      // an error worth a stack trace at error level.
      if (/** @type {NodeJS.ErrnoException} */ (err)?.code === 'ERR_STREAM_PREMATURE_CLOSE') {
        logger.debug('client aborted response', { path: pathname });
        return;
      }

      logger.error('request failed', err, { path: pathname });
      if (!res.headersSent) sendText(res, 500, 'Internal server error');
      else res.destroy();
    }
  };
}
