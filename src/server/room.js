/**
 * A room: one game, its seats, and everyone watching it.
 *
 * The room owns the boundary between connections and the simulation. It decides who
 * gets a seat, when a wave starts, and what each connection is told — but it never
 * decides what happens *in* the game. That is `src/game/`, which this module drives.
 *
 * Two rules shape everything here:
 *
 * 1. Commands are queued as they arrive and applied in order at the start of a tick,
 *    never on arrival. That is what makes two players clicking one tile deterministic
 *    rather than a race against the event loop.
 *
 * 2. Time is a parameter. `tick(nowMs, dtMs)` reads no clock, so the reconnect grace
 *    period and room cleanup are testable without a single sleep.
 */

import { applyCommand } from '../game/commands.js';
import {
  addPlayer,
  allPlayersReady,
  createGameState,
  drainEvents,
  playersNotReady,
  removePlayer,
  resetToLobby,
  setConnected,
  snapshot,
  startGame,
  startWave,
  tick as tickGame,
} from '../game/state.js';
import {
  AFK_TIMEOUT_MS,
  MAX_PLAYERS,
  MAX_SPECTATORS,
  PHASE,
  RECONNECT_GRACE_MS,
} from '../shared/constants.js';
import { REJECT_REASON, SERVER_MSG } from '../shared/protocol.js';

/**
 * Commands allowed to pile up between two ticks, across the whole room.
 *
 * At 20 Hz a human generates at most one or two. This is purely a bound on what a
 * misbehaving or malicious client can make the server allocate.
 */
const MAX_QUEUED_COMMANDS = 256;

/** @typedef {'player' | 'spectator'} Role */

/**
 * @typedef {object} Connection
 * @property {string} id
 * @property {(msg: object) => void} send Transport is injected so tests can drive a room
 *   with no sockets at all.
 */

/**
 * @typedef {object} Seat
 * @property {string} token          Reconnect credential. Never broadcast — only ever
 *                                   sent to the connection that owns it.
 * @property {string} playerId
 * @property {string} name
 * @property {number} index
 * @property {string | null} connectionId
 * @property {number | null} disconnectedAt Timestamp the seat was vacated, or null.
 * @property {number} lastActivityMs Timestamp of the last thing this player did. Drives
 *                                   the idle timeout that stops one absent player from
 *                                   stalling the ready gate for everyone else.
 */

/**
 * The public view of who is in a room.
 *
 * Seat tokens are conspicuously absent and must stay that way — anyone holding one can
 * claim that seat.
 *
 * @typedef {object} Roster
 * @property {string} type
 * @property {string} roomCode
 * @property {Array<{ playerId: string, name: string, connected: boolean, idle: boolean,
 *   afkInMs: number | null }>} players
 * @property {number} spectators
 * @property {string[]} waitingOn Connected players the ready gate is still waiting for.
 */

/**
 * Round a countdown to whole seconds, preserving null.
 *
 * @param {number | null} ms
 * @returns {number | null}
 */
function roundToSecond(ms) {
  return ms === null ? null : Math.ceil(ms / 1000) * 1000;
}

/**
 * @typedef {object} JoinResult
 * @property {boolean} ok
 * @property {Role} [role]
 * @property {string} [seatToken]
 * @property {string} [playerId]
 * @property {string} [reason]
 */

/**
 * Create a room.
 *
 * @param {object} options
 * @param {string} options.code Room code, as it appears in the shareable URL.
 * @param {() => string} options.newToken Seat-token source, injected so tests are
 *   deterministic. Production passes `crypto.randomUUID`.
 * @param {import('../logger.js').Logger} options.logger
 */
export function createRoom({ code, newToken, logger }) {
  const state = createGameState();

  /** @type {Map<string, Connection>} */
  const connections = new Map();
  /** @type {Map<string, Seat>} */
  const seats = new Map();
  /** @type {Set<string>} */
  const spectators = new Set();
  /** @type {Array<{ connectionId: string, playerId: string, msg: any }>} */
  let queue = [];

  /** Timestamp the room last had a live connection; drives the empty-room sweep. */
  let lastOccupiedAt = 0;

  /**
   * The clock as of the most recent tick.
   *
   * Paths that react to a message rather than to the tick — queueing a command, promoting
   * a spectator — need a timestamp but are not handed one, and reading a real clock in
   * them would put wall-time back into code the tests drive with an injected one. A tick
   * is at most 50ms old, which is far below the resolution anything here cares about.
   */
  let lastTickMs = 0;

  /**
   * Set when the roster changes between ticks, so the next tick republishes it.
   *
   * Deferring to the tick rather than broadcasting inline keeps every outbound message
   * on one schedule, and avoids a newcomer receiving a roster before its own welcome.
   */
  let rosterDirty = false;

  /**
   * @param {string} connectionId
   * @returns {Seat | undefined}
   */
  function seatOfConnection(connectionId) {
    for (const seat of seats.values()) {
      if (seat.connectionId === connectionId) return seat;
    }
    return undefined;
  }

  /** @returns {Roster} Everyone's public state. Deliberately excludes seat tokens. */
  function roster() {
    return {
      type: SERVER_MSG.ROSTER,
      roomCode: code,
      players: [...seats.values()]
        .sort((a, b) => a.index - b.index)
        .map((seat) => ({
          playerId: seat.playerId,
          name: seat.name,
          connected: seat.connectionId !== null,
          idle: state.players.get(seat.playerId)?.idle ?? false,
          // Rounded to whole seconds: this is a countdown a human reads, and sending
          // millisecond precision would rebuild the roster list sixty times a second
          // to change a digit nobody can see.
          afkInMs: roundToSecond(afkInMs(seat, lastTickMs)),
        })),
      spectators: spectators.size,
      waitingOn: state.phase === PHASE.BUILD || state.phase === PHASE.LOBBY
        ? playersNotReady(state)
        : [],
    };
  }

  /**
   * @param {object} msg
   * @returns {void}
   */
  function broadcast(msg) {
    for (const connection of connections.values()) {
      connection.send(msg);
    }
  }

  /**
   * Seat a connection, or make it a spectator, or refuse it.
   *
   * A valid seat token always wins, even when the room looks full and even mid-wave:
   * a reconnecting player must never be demoted to spectator by their own empty seat.
   *
   * @param {Connection} connection
   * @param {string} [seatToken]
   * @param {number} [nowMs]
   * @returns {JoinResult}
   */
  function join(connection, seatToken, nowMs = 0) {
    connections.set(connection.id, connection);
    lastOccupiedAt = nowMs;
    rosterDirty = true;

    const held = seatToken === undefined ? undefined : seats.get(seatToken);
    if (held !== undefined && held.connectionId === null) {
      held.connectionId = connection.id;
      held.disconnectedAt = null;
      // Coming back is activity. Without this a player who reconnects after a long
      // absence is idle on arrival and the gate ignores them.
      held.lastActivityMs = nowMs;
      setConnected(state, held.playerId, true);

      logger.info('seat reclaimed', { room: code, playerId: held.playerId });
      return { ok: true, role: 'player', seatToken: held.token, playerId: held.playerId };
    }

    // New seats are only handed out in the lobby. Joining a game already in progress
    // makes you a spectator — there is no sensible fish balance for a wave-12 arrival.
    if (state.phase === PHASE.LOBBY && seats.size < MAX_PLAYERS) {
      const index = seats.size;
      const seat = {
        token: newToken(),
        playerId: `p${index + 1}`,
        name: `Penguin ${index + 1}`,
        index,
        connectionId: connection.id,
        disconnectedAt: null,
        lastActivityMs: nowMs,
      };
      seats.set(seat.token, seat);
      addPlayer(state, seat.playerId, seat.name);

      logger.info('player seated', { room: code, playerId: seat.playerId });
      return { ok: true, role: 'player', seatToken: seat.token, playerId: seat.playerId };
    }

    if (spectators.size >= MAX_SPECTATORS) {
      connections.delete(connection.id);
      rosterDirty = false;
      return { ok: false, reason: REJECT_REASON.ROOM_FULL };
    }

    spectators.add(connection.id);
    logger.info('spectator joined', { room: code, spectators: spectators.size });
    return { ok: true, role: 'spectator' };
  }

  /**
   * Drop a connection.
   *
   * A player's seat is *held*, not freed: their towers keep firing and their fish is
   * preserved until the grace period expires. They are marked disconnected immediately
   * though, which removes them from the ready gate — without that, one dropped
   * connection stalls everyone else indefinitely, because the gate has no timeout.
   *
   * @param {string} connectionId
   * @param {number} nowMs
   * @returns {void}
   */
  function disconnect(connectionId, nowMs) {
    connections.delete(connectionId);
    spectators.delete(connectionId);
    rosterDirty = true;

    const seat = seatOfConnection(connectionId);
    if (seat !== undefined) {
      seat.connectionId = null;
      seat.disconnectedAt = nowMs;
      setConnected(state, seat.playerId, false);
      logger.info('player disconnected', { room: code, playerId: seat.playerId });
    }

    // Drop anything they had queued but not yet applied, so a command cannot land from
    // someone who is already gone.
    queue = queue.filter((entry) => entry.connectionId !== connectionId);

    // The room was occupied right up to this instant, including by the connection just
    // removed. Skipping this when the room empties would start the idle countdown from
    // the last tick that had someone in it, destroying the room early.
    lastOccupiedAt = nowMs;
  }

  /**
   * Queue a validated client message.
   *
   * Spectators are refused here rather than at the simulation, so read-only really is
   * read-only regardless of what the game would have allowed.
   *
   * @param {string} connectionId
   * @param {{ type: string } & Record<string, unknown>} msg
   * @returns {void}
   */
  function enqueue(connectionId, msg) {
    const connection = connections.get(connectionId);
    if (connection === undefined) return;

    const seat = seatOfConnection(connectionId);
    if (seat === undefined) {
      connection.send({
        type: SERVER_MSG.EVENT,
        kind: 'commandRejected',
        reason: REJECT_REASON.NOT_A_PLAYER,
      });
      return;
    }

    // Any command counts as being present, including un-readying — the gate exists to
    // route around absence, not to punish someone who changes their mind slowly. Set
    // before the queue bound below, so a player whose clicks are being dropped for
    // flooding is still unmistakably here.
    seat.lastActivityMs = lastTickMs;

    if (msg.type === 'playAgain') {
      if (state.phase === PHASE.GAME_OVER) promoteAndReset();
      return;
    }

    // Bound the queue. A client that spams commands faster than the tick drains them
    // would otherwise grow this array without limit; dropping the excess costs that
    // client some clicks and costs everyone else nothing.
    if (queue.length >= MAX_QUEUED_COMMANDS) {
      logger.warn('command queue full, dropping', { room: code, connectionId });
      return;
    }

    queue.push({ connectionId, playerId: seat.playerId, msg });
  }

  /**
   * Mark connected-but-inactive players idle, so the ready gate stops waiting on them.
   *
   * Recomputed from scratch every tick rather than latched, so acting again clears it
   * immediately — a player who comes back should not have to wait out a second timer.
   *
   * @param {number} nowMs
   * @returns {boolean} True when anyone's idle state changed, so the roster is republished.
   */
  function refreshIdle(nowMs) {
    let changed = false;

    for (const seat of seats.values()) {
      const player = state.players.get(seat.playerId);
      if (player === undefined) continue;

      const idle =
        seat.connectionId !== null && nowMs - seat.lastActivityMs >= AFK_TIMEOUT_MS;

      if (player.idle !== idle) {
        player.idle = idle;
        changed = true;
      }
    }

    return changed;
  }

  /**
   * Milliseconds until a seat idles out, or null when the question does not apply.
   *
   * @param {Seat} seat
   * @param {number} nowMs
   * @returns {number | null}
   */
  function afkInMs(seat, nowMs) {
    if (seat.connectionId === null) return null;
    const remaining = AFK_TIMEOUT_MS - (nowMs - seat.lastActivityMs);
    return remaining > 0 ? remaining : null;
  }

  /**
   * Return a finished game to the lobby, promoting spectators into any free seats.
   *
   * This is the only path by which a spectator becomes a player, which is why it runs
   * before the roster goes out.
   *
   * @returns {void}
   */
  function promoteAndReset() {
    resetToLobby(state);

    for (const connectionId of [...spectators]) {
      if (seats.size >= MAX_PLAYERS) break;

      const index = seats.size;
      const seat = {
        token: newToken(),
        playerId: `p${index + 1}`,
        name: `Penguin ${index + 1}`,
        index,
        connectionId,
        disconnectedAt: null,
        // Being promoted out of the gallery counts as arriving, not as having sat idle
        // for however long the previous game lasted.
        lastActivityMs: lastTickMs,
      };
      seats.set(seat.token, seat);
      addPlayer(state, seat.playerId, seat.name);
      spectators.delete(connectionId);

      const connection = connections.get(connectionId);
      if (connection !== undefined) {
        // A promoted spectator needs its credential, and it goes only to them.
        connection.send({
          type: SERVER_MSG.WELCOME,
          role: 'player',
          seatToken: seat.token,
          playerId: seat.playerId,
          roomCode: code,
        });
      }
      logger.info('spectator promoted', { room: code, playerId: seat.playerId });
    }

    broadcast(roster());
  }

  /**
   * Free seats whose grace period has expired.
   *
   * @param {number} nowMs
   * @returns {boolean} Whether anything changed.
   */
  function expireSeats(nowMs) {
    let changed = false;

    for (const [token, seat] of seats) {
      if (seat.disconnectedAt === null) continue;
      if (nowMs - seat.disconnectedAt < RECONNECT_GRACE_MS) continue;

      // Their towers stay on the board — they were bought with shared effort — but the
      // seat and its unspent fish are gone.
      removePlayer(state, seat.playerId);
      seats.delete(token);
      changed = true;
      logger.info('seat expired', { room: code, playerId: seat.playerId });
    }

    return changed;
  }

  /**
   * Advance the room by one step.
   *
   * @param {number} nowMs Wall clock, injected.
   * @param {number} dtMs Fixed timestep for the simulation.
   * @returns {void}
   */
  function tick(nowMs, dtMs) {
    lastTickMs = nowMs;
    if (connections.size > 0) lastOccupiedAt = nowMs;

    // Apply queued commands first, in arrival order. Anything rejected is reported only
    // to the player who asked, since nobody else needs to know.
    const pending = queue;
    queue = [];
    for (const entry of pending) {
      const result = applyCommand(state, entry.playerId, entry.msg);
      if (!result.ok) {
        connections.get(entry.connectionId)?.send({
          type: SERVER_MSG.EVENT,
          kind: 'commandRejected',
          reason: result.reason,
          request: entry.msg,
        });
      }
    }

    const rosterChanged = expireSeats(nowMs) || refreshIdle(nowMs);

    // The ready gate. In the lobby it starts the game; between waves it sends the next
    // one. Both require every *connected* player, so a dropout cannot stall the room.
    if (state.phase === PHASE.LOBBY && seats.size > 0 && allPlayersReady(state)) {
      startGame(state);
    } else if (state.phase === PHASE.BUILD && allPlayersReady(state)) {
      startWave(state);
    }

    tickGame(state, dtMs);

    const events = drainEvents(state);
    if (events.length > 0) {
      for (const event of events) {
        broadcast({ type: SERVER_MSG.EVENT, ...event });
      }
    }

    if (rosterDirty || rosterChanged || events.length > 0) {
      broadcast(roster());
      rosterDirty = false;
    }

    broadcast({ type: SERVER_MSG.SNAPSHOT, ...snapshot(state) });
  }

  return {
    code,

    /** @returns {number} Live connections, players and spectators together. */
    get connectionCount() {
      return connections.size;
    },

    /** @returns {number} Seats handed out, including ones held for a reconnect. */
    get seatCount() {
      return seats.size;
    },

    /** @returns {number} Connections watching read-only. */
    get spectatorCount() {
      return spectators.size;
    },

    /** @returns {import('../game/state.js').GameState} For tests and diagnostics. */
    get state() {
      return state;
    },

    /**
     * Whether the room has been unoccupied long enough to destroy.
     *
     * @param {number} nowMs
     * @param {number} idleMs
     * @returns {boolean}
     */
    isExpired(nowMs, idleMs) {
      return connections.size === 0 && nowMs - lastOccupiedAt >= idleMs;
    },

    join,
    disconnect,
    enqueue,
    tick,
    roster,
    snapshot: () => snapshot(state),
  };
}

/** @typedef {ReturnType<typeof createRoom>} Room */
