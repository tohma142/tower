/**
 * The WebSocket boundary.
 *
 * Everything arriving here is untrusted text. This module's whole job is to turn that
 * into either a validated message handed to a room, or a rejection — and to make sure
 * nothing in between can allocate unbounded memory or reach game code unvalidated.
 *
 * Node ships a WebSocket *client* but no server, which is why `ws` is the one runtime
 * dependency in the project.
 */

import { WebSocketServer } from 'ws';

import { CLIENT_MSG, REJECT_REASON, SERVER_MSG, validateClientMessage } from '../shared/protocol.js';

/**
 * Largest client frame accepted, in bytes.
 *
 * The biggest legitimate message is a `hello` carrying a room code and a UUID — well
 * under 200 bytes. `ws` drops anything larger before it is buffered, so an oversized
 * frame costs nothing to refuse.
 */
const MAX_PAYLOAD_BYTES = 4096;

/**
 * How often to check for sockets that have stopped answering.
 *
 * A TCP connection can survive its peer vanishing — a laptop lid closing, a network
 * dropping — leaving a socket that is open but dead. Without this, that seat is held
 * until the process restarts, and with the all-players-ready gate the room stalls.
 */
const HEARTBEAT_MS = 30_000;

/**
 * Attach a WebSocket server to an existing HTTP server.
 *
 * @param {object} options
 * @param {import('node:http').Server} options.server
 * @param {import('./rooms.js').RoomRegistry} options.rooms
 * @param {import('../logger.js').Logger} options.logger
 * @param {() => string} options.newId Connection id source, injected for testability.
 * @returns {{ close: () => Promise<void> }}
 */
export function attachSocketServer({ server, rooms, logger, newId }) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_PAYLOAD_BYTES });

  /** @type {Map<import('ws').WebSocket, { id: string, room: import('./room.js').Room | null, alive: boolean }>} */
  const sessions = new Map();

  /**
   * @param {import('ws').WebSocket} socket
   * @param {object} msg
   * @returns {void}
   */
  function send(socket, msg) {
    // OPEN is 1. A socket can close between a broadcast being composed and delivered,
    // and writing to a closed socket throws.
    if (socket.readyState !== 1) return;
    socket.send(JSON.stringify(msg));
  }

  /**
   * @param {import('ws').WebSocket} socket
   * @param {string} reason
   * @returns {void}
   */
  function rejectAndClose(socket, reason) {
    send(socket, { type: SERVER_MSG.REJECTED, reason });
    socket.close(1008, reason);
  }

  /**
   * Handle the first message on a connection, which must be a hello.
   *
   * @param {import('ws').WebSocket} socket
   * @param {{ id: string, room: import('./room.js').Room | null }} session
   * @param {{ roomCode?: string, seatToken?: string }} msg
   * @returns {void}
   */
  function handleHello(socket, session, msg) {
    // No code means "make me a room". The client rewrites its URL to the shareable
    // form once the welcome comes back with the allocated code.
    const room = msg.roomCode === undefined ? rooms.create() : rooms.get(msg.roomCode);

    if (room === undefined) {
      // Deliberately distinguishable from a full room: a mistyped code and a busy room
      // need different things from the player.
      rejectAndClose(socket, REJECT_REASON.ROOM_NOT_FOUND);
      return;
    }

    const result = room.join(
      { id: session.id, send: (/** @type {object} */ out) => send(socket, out) },
      msg.seatToken,
      Date.now(),
    );

    if (!result.ok) {
      rejectAndClose(socket, result.reason ?? REJECT_REASON.ROOM_FULL);
      return;
    }

    session.room = room;

    // The seat token is a credential. It goes to exactly one connection and appears in
    // no roster, snapshot, or broadcast.
    send(socket, {
      type: SERVER_MSG.WELCOME,
      roomCode: room.code,
      role: result.role,
      playerId: result.playerId ?? null,
      seatToken: result.seatToken ?? null,
    });

    send(socket, room.roster());

    // Deliberately no snapshot here. Sending one would stamp a point-in-time read with
    // the current tick number, while that same tick's broadcast — composed at a
    // different moment — carries different contents. Two clients would then hold
    // disagreeing snapshots bearing the same tick, which is exactly the failure a
    // server-authoritative design exists to rule out. The next tick is at most 50ms
    // away and reaches everyone with one payload.
  }

  wss.on('connection', (socket) => {
    const session = { id: newId(), room: /** @type {any} */ (null), alive: true };
    sessions.set(socket, session);

    socket.on('pong', () => {
      session.alive = true;
    });

    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        rejectAndClose(socket, 'binary frames are not accepted');
        return;
      }

      /** @type {unknown} */
      let parsed;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        send(socket, { type: SERVER_MSG.EVENT, kind: 'protocolError', reason: 'malformed JSON' });
        return;
      }

      const validation = validateClientMessage(parsed);
      if (!validation.ok) {
        // Reported rather than fatal: a version-skewed client should learn what it got
        // wrong, not simply find its socket shut.
        send(socket, {
          type: SERVER_MSG.EVENT,
          kind: 'protocolError',
          reason: validation.error,
        });
        return;
      }

      const msg = validation.value;

      if (msg.type === CLIENT_MSG.HELLO) {
        if (session.room !== null) {
          send(socket, {
            type: SERVER_MSG.EVENT,
            kind: 'protocolError',
            reason: 'already joined',
          });
          return;
        }
        handleHello(socket, session, /** @type {any} */ (msg));
        return;
      }

      // Everything else requires a room. A client sending commands before its hello is
      // a bug on its side; say so rather than silently dropping them.
      if (session.room === null) {
        send(socket, {
          type: SERVER_MSG.EVENT,
          kind: 'protocolError',
          reason: 'hello must come first',
        });
        return;
      }

      session.room.enqueue(session.id, msg);
    });

    socket.on('close', () => {
      const closing = sessions.get(socket);
      sessions.delete(socket);
      closing?.room?.disconnect(closing.id, Date.now());
    });

    socket.on('error', (err) => {
      logger.warn('socket error', { connectionId: session.id, message: err.message });
    });
  });

  // Ping every live socket; anything that failed to answer the previous round is
  // terminated so its seat can start its reconnect grace period.
  const heartbeat = setInterval(() => {
    for (const [socket, session] of sessions) {
      if (!session.alive) {
        logger.info('terminating unresponsive socket', { connectionId: session.id });
        socket.terminate();
        continue;
      }
      session.alive = false;
      socket.ping();
    }
  }, HEARTBEAT_MS);

  // Without unref, this timer alone keeps the process alive through a clean shutdown.
  heartbeat.unref();

  return {
    /**
     * Stop accepting connections and close the ones still open.
     *
     * @returns {Promise<void>}
     */
    close() {
      clearInterval(heartbeat);
      for (const socket of sessions.keys()) {
        socket.close(1001, 'server shutting down');
      }
      return new Promise((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
