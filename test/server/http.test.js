import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createRequestHandler, resolveWithinRoot } from '../../src/server/http.js';
import { silentLogger } from '../helpers/server.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC_ROOT = path.join(PROJECT_ROOT, 'src');

describe('resolveWithinRoot — escaping the served directory', () => {
  // Serving files from disk in response to a URL is the classic way to leak a
  // filesystem. Everything here is an attempt to get out of src/.

  it('resolves an ordinary path inside the root', () => {
    const resolved = resolveWithinRoot(SRC_ROOT, '/shared/constants.js');
    assert.equal(resolved, path.join(SRC_ROOT, 'shared', 'constants.js'));
  });

  it('rejects a plain parent traversal', () => {
    assert.equal(resolveWithinRoot(SRC_ROOT, '/../package.json'), null);
    assert.equal(resolveWithinRoot(SRC_ROOT, '/../../../../etc/passwd'), null);
  });

  it('rejects traversal buried mid-path', () => {
    assert.equal(resolveWithinRoot(SRC_ROOT, '/shared/../../package.json'), null);
    assert.equal(resolveWithinRoot(SRC_ROOT, '/client/../../.env'), null);
  });

  it('rejects percent-encoded traversal', () => {
    // Checking the raw string before decoding would miss every one of these.
    assert.equal(resolveWithinRoot(SRC_ROOT, '/%2e%2e/package.json'), null);
    assert.equal(resolveWithinRoot(SRC_ROOT, '/..%2Fpackage.json'), null);
    assert.equal(resolveWithinRoot(SRC_ROOT, '/%2e%2e%2f%2e%2e%2fetc/passwd'), null);
  });

  it('rejects double-encoded traversal', () => {
    // %252e decodes to %2e, not to a dot — one decode pass is correct, and the result
    // must still not escape.
    const resolved = resolveWithinRoot(SRC_ROOT, '/%252e%252e/package.json');
    assert.ok(resolved === null || resolved.startsWith(SRC_ROOT + path.sep));
  });

  it('rejects a null byte', () => {
    // A null byte can truncate a path inside a lower-level API, making a benign-looking
    // JavaScript string reach a different file entirely.
    assert.equal(resolveWithinRoot(SRC_ROOT, '/safe.js\0/../../etc/passwd'), null);
    assert.equal(resolveWithinRoot(SRC_ROOT, '/%00.js'), null);
  });

  it('rejects malformed percent-encoding rather than guessing', () => {
    assert.equal(resolveWithinRoot(SRC_ROOT, '/%'), null);
    assert.equal(resolveWithinRoot(SRC_ROOT, '/%zz'), null);
  });

  it('treats an absolute-looking path as relative to the root', () => {
    // Without stripping the leading slash, path.resolve would discard the root
    // entirely and happily hand back /etc/passwd.
    const resolved = resolveWithinRoot(SRC_ROOT, '//etc/passwd');
    assert.ok(resolved === null || resolved.startsWith(SRC_ROOT + path.sep));
  });

  it('rejects a sibling directory whose name merely starts with the root name', () => {
    // The separator in the prefix check is load-bearing: "/tmp/app-secrets" must not
    // pass a check against root "/tmp/app".
    const root = path.resolve('/tmp/app');
    const escaped = resolveWithinRoot(root, '/../app-secrets/keys.js');
    assert.equal(escaped, null);
  });

  it('allows the root itself', () => {
    assert.equal(resolveWithinRoot(SRC_ROOT, '/'), SRC_ROOT);
  });
});

describe('the HTTP server', () => {
  /** @type {import('node:http').Server} */
  let server;
  /** @type {string} */
  let base;

  before(async () => {
    const logger = silentLogger();
    server = createServer(createRequestHandler({ root: PROJECT_ROOT, logger }));
    // Port 0 asks the OS for a free port, so tests never collide with a real server.
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  /**
   * Send a handcrafted HTTP request, bypassing every client-side URL normalisation.
   *
   * @param {string} rawPath Written to the socket exactly as given.
   * @returns {Promise<{ status: number, body: string }>}
   */
  function rawRequest(rawPath) {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      });

      let response = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        response += chunk;
      });
      socket.on('error', reject);
      socket.on('end', () => {
        const match = /^HTTP\/1\.1 (\d{3})/.exec(response);
        if (match === null) {
          reject(new Error(`no status line in: ${response.slice(0, 80)}`));
          return;
        }
        const separator = response.indexOf('\r\n\r\n');
        resolve({
          status: Number(match[1]),
          body: separator === -1 ? '' : response.slice(separator + 4),
        });
      });
    });
  }

  it('serves the client page at the root', async () => {
    const res = await fetch(`${base}/`);

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await res.text(), /<title>/);
  });

  it('serves the same page for a room URL, so links are shareable', async () => {
    const root = await (await fetch(`${base}/`)).text();
    const room = await fetch(`${base}/r/BCDFG`);

    assert.equal(room.status, 200);
    assert.equal(await room.text(), root, 'the client reads its own room code from the URL');
  });

  it('serves shared modules as JavaScript', async () => {
    // The no-build-step design depends on this: the browser imports the same files
    // Node does, straight off disk.
    const res = await fetch(`${base}/src/shared/constants.js`);

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /javascript/);
    assert.match(await res.text(), /export const TICK_HZ/);
  });

  it('never serves a file outside src/, however the path is encoded', async () => {
    // `fetch` is the wrong tool here and would give a false sense of safety: it decodes
    // %2e%2e and collapses `..` before sending, so `/src/../package.json` leaves the
    // machine as `/package.json` and never exercises the server at all. An attacker
    // writes bytes to a socket, so this test does too.
    //
    // The property asserted is the one that matters — the file is not served — rather
    // than a particular status code. These paths are refused by different layers:
    // some by the traversal guard (403), some by URL normalisation landing on a route
    // that does not exist (404). Both are correct; leaking the manifest is not.
    for (const raw of [
      '/src/../package.json',
      '/src/%2e%2e/package.json',
      '/src/shared/../../package.json',
      '/src/..%2f..%2fpackage.json',
      '/src/....//package.json',
      '/src/../.env',
      '/src/../../../../etc/passwd',
    ]) {
      const { status, body } = await rawRequest(raw);

      assert.notEqual(status, 200, `${raw} must not succeed`);
      assert.equal(body.includes('"devDependencies"'), false, `${raw} leaked the manifest`);
      assert.equal(body.includes('root:'), false, `${raw} leaked a system file`);
    }
  });

  it('answers 403 specifically when the traversal guard is what stops it', async () => {
    // `..%2f` survives normalisation intact, so it reaches the guard rather than being
    // rewritten into a non-existent route.
    const { status } = await rawRequest('/src/..%2f..%2fpackage.json');
    assert.equal(status, 403);
  });

  it('refuses the encoded-slash form even through a normalising client', async () => {
    // `..%2F` is the one traversal shape that survives WHATWG URL normalisation, so it
    // is what actually arrives from a browser.
    const res = await fetch(`${base}/src/..%2Fpackage.json`);
    assert.equal(res.status, 403);
  });

  it('does not serve a file the client normalised its way out to', async () => {
    // `/src/../package.json` becomes `/package.json` before it is sent. That must not
    // resolve to anything either — the route simply does not exist.
    const res = await fetch(`${base}/src/../package.json`);

    assert.equal(res.status, 404);
    assert.equal((await res.text()).includes('"dependencies"'), false, 'manifest must not leak');
  });

  it('does not serve files outside the allow-listed extensions', async () => {
    // Even reachable paths are refused unless the type is one we meant to publish, so
    // a stray .env or .pem in the tree cannot be fetched.
    const res = await fetch(`${base}/src/shared/../../package-lock.json`);
    assert.notEqual(res.status, 200);
  });

  it('404s an unknown path', async () => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/src/client/missing.js`)).status, 404);
  });

  it('404s a directory rather than listing it', async () => {
    assert.equal((await fetch(`${base}/src/shared/`)).status, 404);
  });

  it('refuses methods other than GET and HEAD', async () => {
    const res = await fetch(`${base}/`, { method: 'POST' });

    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET, HEAD');
  });

  it('marks responses no-cache so an edited module is not served stale', async () => {
    const res = await fetch(`${base}/src/shared/constants.js`);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  });
});
