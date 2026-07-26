/**
 * End-to-end over real sockets.
 *
 * Every other server test drives rooms in-process with fake connections, which is fast
 * and deterministic but proves nothing about `ws` framing, real socket closes, or the
 * loop actually running. This one boots the real server on an ephemeral port and talks
 * to it with real WebSocket clients.
 *
 * Nothing here sleeps. Waits are on actual signals — a message arriving, a socket
 * closing — with a deadline that fails the test rather than hanging the suite.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';

import { createRequestHandler } from '../../src/server/http.js';
import { createLoop } from '../../src/server/loop.js';
import { createRoomRegistry } from '../../src/server/rooms.js';
import { attachSocketServer } from '../../src/server/socket.js';
import { TICK_MS } from '../../src/shared/constants.js';
import { SERVER_MSG } from '../../src/shared/protocol.js';
import { silentLogger } from '../helpers/server.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** How long any single wait may take before the test fails instead of hanging. */
const DEADLINE_MS = 5000;

/**
 * A WebSocket client that records what it receives and can wait for a condition.
 *
 * @param {string} url
 */
function connectClient(url) {
  const socket = new WebSocket(url);
  /** @type {any[]} */
  const received = [];
  /** @type {Array<{ predicate: (m: any) => boolean, resolve: (m: any) => void }>} */
  let waiters = [];

  socket.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    received.push(msg);

    // Resolve every waiter this message satisfies, and keep the rest.
    waiters = waiters.filter((waiter) => {
      if (!waiter.predicate(msg)) return true;
      waiter.resolve(msg);
      return false;
    });
  });

  return {
    socket,
    received,

    /** @returns {Promise<void>} */
    open() {
      if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
      return new Promise((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });
    },

    /** @param {object} msg */
    send(msg) {
      socket.send(JSON.stringify(msg));
    },

    /**
     * Resolve when a message satisfying `predicate` arrives, checking what already did.
     *
     * @param {(m: any) => boolean} predicate
     * @param {string} describe Used in the timeout message.
     * @returns {Promise<any>}
     */
    waitFor(predicate, describe) {
      const already = received.find(predicate);
      if (already !== undefined) return Promise.resolve(already);

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`timed out waiting for ${describe}`));
        }, DEADLINE_MS);

        waiters.push({
          predicate,
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg);
          },
        });
      });
    },

    /** @returns {Promise<void>} */
    close() {
      if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
      return new Promise((resolve) => {
        socket.once('close', () => resolve());
        socket.close();
      });
    },

    /** @param {string} type @returns {any[]} */
    ofType(type) {
      return received.filter((m) => m.type === type);
    },
  };
}

describe('two real clients sharing a game', () => {
  /** @type {import('node:http').Server} */
  let server;
  /** @type {{ close: () => Promise<void> }} */
  let sockets;
  /** @type {ReturnType<typeof createLoop>} */
  let loop;
  /** @type {string} */
  let wsUrl;
  /** @type {Array<ReturnType<typeof connectClient>>} */
  const clients = [];

  before(async () => {
    const logger = silentLogger();
    const rooms = createRoomRegistry({
      randomInt: (max) => Math.floor(Math.random() * max),
      newToken: () => crypto.randomUUID(),
      logger,
    });

    server = createServer(createRequestHandler({ root: PROJECT_ROOT, logger }));
    sockets = attachSocketServer({ server, rooms, logger, newId: () => crypto.randomUUID() });
    loop = createLoop({
      tickMs: TICK_MS,
      logger,
      onTick: (nowMs, dtMs) => rooms.tickAll(nowMs, dtMs),
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    loop.start();

    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    wsUrl = `ws://127.0.0.1:${port}/ws`;
  });

  after(async () => {
    loop.stop();
    await Promise.all(clients.map((c) => c.close()));
    await sockets.close();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  /**
   * @param {string} [roomCode]
   * @param {string} [seatToken]
   */
  async function join(roomCode, seatToken) {
    const client = connectClient(wsUrl);
    clients.push(client);
    await client.open();

    client.send({
      type: 'hello',
      ...(roomCode === undefined ? {} : { roomCode }),
      ...(seatToken === undefined ? {} : { seatToken }),
    });

    const welcome = await client.waitFor((m) => m.type === SERVER_MSG.WELCOME, 'welcome');
    return { client, welcome };
  }

  it('creates a room, admits a second player by code, and keeps them in lockstep', async () => {
    const host = await join();
    assert.equal(host.welcome.role, 'player');
    assert.match(host.welcome.roomCode, /^[A-Z0-9]{5}$/);
    assert.ok(host.welcome.seatToken, 'the host needs a reconnect credential');

    // The second player joins with nothing but the code from the shareable URL.
    const guest = await join(host.welcome.roomCode);
    assert.equal(guest.welcome.role, 'player');
    assert.equal(guest.welcome.roomCode, host.welcome.roomCode);
    assert.notEqual(guest.welcome.playerId, host.welcome.playerId);

    await host.client.waitFor(
      (m) => m.type === SERVER_MSG.ROSTER && m.players.length === 2,
      'the host to see the guest arrive',
    );

    // Both ready: once to start the game, once to send wave 1.
    host.client.send({ type: 'ready', value: true });
    guest.client.send({ type: 'ready', value: true });
    await host.client.waitFor((m) => m.type === SERVER_MSG.SNAPSHOT && m.phase === 'build', 'build');

    host.client.send({ type: 'ready', value: true });
    guest.client.send({ type: 'ready', value: true });
    await host.client.waitFor((m) => m.type === SERVER_MSG.SNAPSHOT && m.phase === 'wave', 'wave 1');

    // One player builds; the other must see it without having done anything.
    host.client.send({ type: 'place', tileX: 0, tileY: 0, towerType: 'pistol' });

    const guestSaw = await guest.client.waitFor(
      (m) => m.type === SERVER_MSG.SNAPSHOT && m.towers.length === 1,
      "the guest to see the host's penguin",
    );
    assert.equal(guestSaw.towers[0].owner, host.welcome.playerId);

    // Let a wave actually run for a while, so the comparison below covers ticks with
    // enemies moving, towers firing, and projectiles in flight — not just an idle
    // board. This waits on snapshots arriving, not on a timer.
    await guest.client.waitFor(
      () => guest.client.ofType(SERVER_MSG.SNAPSHOT).length >= 40,
      '40 snapshots of live play',
    );

    // The defining property of a server-authoritative design: for any tick both
    // clients received, the two snapshots are byte-identical.
    const hostByTick = new Map(host.client.ofType(SERVER_MSG.SNAPSHOT).map((s) => [s.tick, s]));
    const guestByTick = new Map(guest.client.ofType(SERVER_MSG.SNAPSHOT).map((s) => [s.tick, s]));

    let compared = 0;
    let withEnemies = 0;
    for (const [tick, hostSnap] of hostByTick) {
      const guestSnap = guestByTick.get(tick);
      if (guestSnap === undefined) continue;
      assert.deepEqual(guestSnap, hostSnap, `snapshots differ at tick ${tick}`);
      compared += 1;
      if (hostSnap.enemies.length > 0) withEnemies += 1;
    }

    assert.ok(compared >= 30, `expected many shared ticks to compare, got ${compared}`);
    assert.ok(withEnemies > 0, 'the comparison should cover ticks with enemies on the board');
  });

  it('turns a mistyped room code away with a distinguishable reason', async () => {
    const client = connectClient(wsUrl);
    clients.push(client);
    await client.open();

    client.send({ type: 'hello', roomCode: 'ZZZZZ' });
    const rejected = await client.waitFor((m) => m.type === SERVER_MSG.REJECTED, 'rejection');

    assert.equal(rejected.reason, 'roomNotFound');
  });

  it('reports a protocol violation instead of silently dropping it', async () => {
    const host = await join();

    host.client.send({ type: 'place', tileX: 999, tileY: 0, towerType: 'pistol' });
    const error = await host.client.waitFor(
      (m) => m.type === SERVER_MSG.EVENT && m.kind === 'protocolError',
      'a protocol error',
    );

    assert.match(error.reason, /tileX/);
  });

  it('survives malformed JSON without dropping the connection', async () => {
    const host = await join();

    host.client.socket.send('{not json');
    const error = await host.client.waitFor(
      (m) => m.type === SERVER_MSG.EVENT && m.kind === 'protocolError',
      'a JSON error',
    );
    assert.match(error.reason, /malformed JSON/);

    // Still usable afterwards.
    host.client.send({ type: 'ready', value: true });
    await host.client.waitFor((m) => m.type === SERVER_MSG.SNAPSHOT && m.phase === 'build', 'build');
  });

  it('gives a reconnecting player their seat, fish, and penguins back', async () => {
    const host = await join();
    const { roomCode, seatToken, playerId } = host.welcome;

    host.client.send({ type: 'ready', value: true });
    await host.client.waitFor((m) => m.type === SERVER_MSG.SNAPSHOT && m.phase === 'build', 'build');
    host.client.send({ type: 'place', tileX: 0, tileY: 0, towerType: 'pistol' });
    const built = await host.client.waitFor(
      (m) => m.type === SERVER_MSG.SNAPSHOT && m.towers.length === 1,
      'a penguin',
    );
    const fishAfterBuying = built.players.find((/** @type {any} */ p) => p.id === playerId).fish;

    // A real socket close, not a simulated one.
    await host.client.close();

    const back = await join(roomCode, seatToken);
    assert.equal(back.welcome.role, 'player', 'must not be demoted to spectator');
    assert.equal(back.welcome.playerId, playerId, 'same seat');

    const snap = await back.client.waitFor((m) => m.type === SERVER_MSG.SNAPSHOT, 'a snapshot');
    assert.equal(snap.towers.length, 1, 'their penguin kept defending');
    assert.equal(snap.players.find((/** @type {any} */ p) => p.id === playerId).fish, fishAfterBuying);
  });

  it('admits a late arrival as a spectator who can watch but not build', async () => {
    const host = await join();

    host.client.send({ type: 'ready', value: true });
    await host.client.waitFor((m) => m.type === SERVER_MSG.SNAPSHOT && m.phase === 'build', 'build');

    const watcher = await join(host.welcome.roomCode);
    assert.equal(watcher.welcome.role, 'spectator');
    assert.equal(watcher.welcome.seatToken, null, 'a spectator holds no seat credential');

    await watcher.client.waitFor((m) => m.type === SERVER_MSG.SNAPSHOT, 'spectators see the game');

    watcher.client.send({ type: 'place', tileX: 1, tileY: 1, towerType: 'pistol' });
    const refusal = await watcher.client.waitFor(
      (m) => m.type === SERVER_MSG.EVENT && m.kind === 'commandRejected',
      'a refusal',
    );
    assert.equal(refusal.reason, 'notAPlayer');
  });
});
