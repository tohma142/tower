/**
 * The connection to the server.
 *
 * Holds the socket, the seat credential, and the snapshot buffer the renderer samples
 * from. It reconnects on its own, because the interesting case is not a server going
 * away — it is a laptop lid closing for ten seconds while a wave is running, and the
 * player expecting their penguins to still be there when it opens.
 *
 * The seat token lives in `sessionStorage`, keyed by room, so a refresh reclaims the
 * same seat. `sessionStorage` rather than `localStorage` deliberately: the credential
 * should die with the tab, not linger on a shared machine.
 */

import { RENDER_DELAY_MS } from '../shared/constants.js';
import { SERVER_MSG } from '../shared/protocol.js';

import { log } from './log.js';
import { pruneBuffer } from './render/interpolate.js';

/** Reconnect backoff, in milliseconds. The last value repeats. */
const BACKOFF_MS = [400, 800, 1600, 3000, 5000];

/**
 * How much snapshot history to keep.
 *
 * Enough to interpolate across the render delay with room for a late packet, and no
 * more — at 20 snapshots a second an unbounded buffer is a slow memory leak.
 */
const BUFFER_MAX_AGE_MS = RENDER_DELAY_MS * 6;

/**
 * @param {string} roomCode
 * @returns {string}
 */
function seatKey(roomCode) {
  return `tower:seat:${roomCode}`;
}

/**
 * Open and maintain a connection.
 *
 * @param {object} options
 * @param {string | null} options.roomCode Room to join, or null to have one created.
 * @param {(welcome: any) => void} options.onWelcome
 * @param {(roster: any) => void} options.onRoster
 * @param {(event: any) => void} options.onEvent
 * @param {(reason: string) => void} options.onRejected
 * @param {(status: 'connecting' | 'online' | 'offline') => void} options.onStatus
 * @returns {{ buffer: import('./render/interpolate.js').BufferedSnapshot[], send: (msg: object) => void, roomCode: () => string | null, playerId: () => string | null, role: () => string | null, close: () => void }}
 */
export function createConnection({ roomCode, onWelcome, onRoster, onEvent, onRejected, onStatus }) {
  /** @type {import('./render/interpolate.js').BufferedSnapshot[]} */
  const buffer = [];

  /** @type {WebSocket | null} */
  let socket = null;
  /** @type {string | null} */
  let currentRoom = roomCode;
  /** @type {string | null} */
  let playerId = null;
  /** @type {string | null} */
  let role = null;
  let attempt = 0;
  let closedByUs = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let retryTimer = null;

  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

  /** @returns {string | undefined} */
  function storedToken() {
    if (currentRoom === null) return undefined;
    try {
      return sessionStorage.getItem(seatKey(currentRoom)) ?? undefined;
    } catch {
      // Private browsing modes can throw on storage access. Losing the ability to
      // reconnect to the same seat is a far smaller problem than failing to connect.
      return undefined;
    }
  }

  /**
   * @param {string} room
   * @param {string} token
   */
  function rememberToken(room, token) {
    try {
      sessionStorage.setItem(seatKey(room), token);
    } catch {
      log.warn('could not persist seat token; a refresh will not reclaim this seat');
    }
  }

  function connect() {
    onStatus('connecting');
    const ws = new WebSocket(url);
    socket = ws;

    ws.addEventListener('open', () => {
      attempt = 0;
      const token = storedToken();
      ws.send(JSON.stringify({
        type: 'hello',
        ...(currentRoom === null ? {} : { roomCode: currentRoom }),
        ...(token === undefined ? {} : { seatToken: token }),
      }));
    });

    ws.addEventListener('message', (frame) => {
      /** @type {any} */
      let msg;
      try {
        msg = JSON.parse(frame.data);
      } catch {
        log.warn('ignoring unparseable frame from server');
        return;
      }

      switch (msg.type) {
        case SERVER_MSG.WELCOME:
          currentRoom = msg.roomCode;
          playerId = msg.playerId;
          role = msg.role;
          if (msg.seatToken) rememberToken(msg.roomCode, msg.seatToken);
          onStatus('online');
          onWelcome(msg);
          break;

        case SERVER_MSG.SNAPSHOT:
          buffer.push({ snapshot: msg, at: performance.now() });
          pruneBuffer(buffer, performance.now(), BUFFER_MAX_AGE_MS);
          break;

        case SERVER_MSG.ROSTER:
          onRoster(msg);
          break;

        case SERVER_MSG.EVENT:
          onEvent(msg);
          break;

        case SERVER_MSG.REJECTED:
          // A refusal is final: the room is missing or full, and retrying the same
          // hello would just be refused again.
          closedByUs = true;
          onRejected(msg.reason);
          break;

        default:
          log.warn('unknown message type from server', msg.type);
      }
    });

    ws.addEventListener('close', () => {
      socket = null;
      if (closedByUs) return;

      onStatus('offline');

      // Backoff, so a server that is down does not get hammered by every open tab.
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      attempt += 1;
      log.info(`connection lost; retrying in ${delay}ms`);
      retryTimer = setTimeout(connect, delay);
    });

    ws.addEventListener('error', () => {
      // The close handler does the reconnecting; an error without a close is not a
      // state this transport produces.
      log.warn('socket error');
    });
  }

  connect();

  return {
    buffer,

    /** @param {object} msg */
    send(msg) {
      if (socket === null || socket.readyState !== WebSocket.OPEN) {
        log.warn('dropping message sent while offline', msg);
        return;
      }
      socket.send(JSON.stringify(msg));
    },

    roomCode: () => currentRoom,
    playerId: () => playerId,
    role: () => role,

    close() {
      closedByUs = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      socket?.close();
    },
  };
}
