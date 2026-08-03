/**
 * The idle timeout on the ready gate.
 *
 * The gate needs every connected player, so one person who wanders off stalls the room
 * indefinitely. These tests drive a real room with an injected clock — no sleeps — and
 * pin down the two properties that matter: an absent player stops blocking, and a
 * present one never does.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { allPlayersReady, playersNotReady } from '../../src/game/state.js';
import { createLogger } from '../../src/logger.js';
import { createRoom } from '../../src/server/room.js';
import { AFK_TIMEOUT_MS, PHASE, RECONNECT_GRACE_MS, TICK_MS } from '../../src/shared/constants.js';

const silent = createLogger({ level: 'error', write: () => {} });

/**
 * A room with two seated players and a clock the test owns.
 *
 * @returns {{ room: any, clock: { now: number }, advance: (ms: number) => void, sent: Map<string, object[]> }}
 */
function twoPlayerRoom() {
  let tokenCounter = 0;
  const room = createRoom({
    code: 'TESTS',
    newToken: () => `token-${++tokenCounter}`,
    logger: silent,
  });

  /** @type {Map<string, object[]>} */
  const sent = new Map();
  /** @param {string} id */
  const connection = (id) => {
    sent.set(id, []);
    return { id, send: (/** @type {object} */ msg) => sent.get(id)?.push(msg) };
  };

  const a = room.join(connection('ca'), undefined, 0);
  const b = room.join(connection('cb'), undefined, 0);
  assert.equal(a.role, 'player');
  assert.equal(b.role, 'player');

  const clock = { now: 0 };
  const advance = (/** @type {number} */ ms) => {
    // Tick at the real cadence rather than jumping, so anything that depends on being
    // ticked repeatedly is exercised the way production exercises it.
    const until = clock.now + ms;
    while (clock.now < until) {
      clock.now = Math.min(until, clock.now + TICK_MS);
      room.tick(clock.now, TICK_MS);
    }
  };

  return { room, clock, advance, sent };
}

/**
 * @param {any} room
 * @param {string} playerId
 */
function playerOf(room, playerId) {
  const found = room.state.players.get(playerId);
  assert.ok(found !== undefined, `no such player: ${playerId}`);
  return found;
}

describe('the idle timeout', () => {
  it('leaves an active player blocking the gate', () => {
    const { room, advance } = twoPlayerRoom();
    advance(AFK_TIMEOUT_MS - TICK_MS * 2);

    assert.equal(playerOf(room, 'p1').idle, false);
    assert.equal(playerOf(room, 'p2').idle, false);
  });

  it('idles a player out once the timeout passes', () => {
    const { room, advance } = twoPlayerRoom();
    advance(AFK_TIMEOUT_MS + TICK_MS);

    assert.equal(playerOf(room, 'p1').idle, true);
  });

  it('is still blocked by a player who is present but has not readied', () => {
    const { room, advance } = twoPlayerRoom();
    room.enqueue('ca', { type: 'ready', value: true });
    advance(TICK_MS * 2);

    assert.equal(allPlayersReady(room.state), false, 'must still be waiting on p2');
    assert.equal(room.state.phase, PHASE.LOBBY);
  });

  it('starts the game once the blocking player idles out', () => {
    // The whole point. One player readies, the other never touches anything.
    //
    // Asserted on the phase rather than on allPlayersReady: the gate opening is what
    // *calls* startGame, and startGame clears everyone's ready flag for the build phase.
    // Re-reading the predicate afterwards would be reading the next phase's state and
    // concluding the gate never opened.
    const { room, advance } = twoPlayerRoom();
    room.enqueue('ca', { type: 'ready', value: true });
    advance(TICK_MS * 2);
    assert.equal(room.state.phase, PHASE.LOBBY);

    advance(AFK_TIMEOUT_MS + TICK_MS);

    assert.equal(room.state.phase, PHASE.BUILD);
  });

  it('drops an idled player out of the waiting-on list', () => {
    // Naming someone the room is no longer blocked on sends the team chasing the wrong
    // person.
    const { room, advance } = twoPlayerRoom();
    advance(TICK_MS);
    assert.deepEqual(playersNotReady(room.state).sort(), ['Penguin 1', 'Penguin 2']);

    room.enqueue('ca', { type: 'ready', value: true });
    advance(AFK_TIMEOUT_MS + TICK_MS);

    assert.deepEqual(playersNotReady(room.state), []);
  });
});

describe('activity resets the timer', () => {
  it('clears idle the moment a player acts again', () => {
    const { room, advance } = twoPlayerRoom();
    advance(AFK_TIMEOUT_MS + TICK_MS);
    assert.equal(playerOf(room, 'p2').idle, true);

    room.enqueue('cb', { type: 'ready', value: true });
    advance(TICK_MS);

    assert.equal(playerOf(room, 'p2').idle, false, 'coming back must not need a second timer');
  });

  it('counts any command, not just readying', () => {
    // Placing a penguin is the most common thing a player does during a build phase.
    // A gate that only counted the ready button would idle out someone mid-build.
    const { room, advance } = twoPlayerRoom();
    room.enqueue('ca', { type: 'ready', value: true });
    room.enqueue('cb', { type: 'ready', value: true });
    advance(TICK_MS * 2);
    assert.equal(room.state.phase, PHASE.BUILD);

    // Half a timeout of silence, then a placement, then another half.
    advance(AFK_TIMEOUT_MS * 0.6);
    room.enqueue('ca', { type: 'place', tileX: 0, tileY: 0, towerType: 'pistol' });
    advance(AFK_TIMEOUT_MS * 0.6);

    assert.equal(playerOf(room, 'p1').idle, false, 'placing must count as being present');
    assert.equal(playerOf(room, 'p2').idle, true, 'and silence must not');
  });

  it('counts a rejected command, since the player is plainly still here', () => {
    const { room, advance } = twoPlayerRoom();
    advance(AFK_TIMEOUT_MS * 0.6);
    // Nothing to sell, so this is refused — but it was still a human clicking.
    room.enqueue('ca', { type: 'place', tileX: 0, tileY: 0, towerType: 'pistol' });
    advance(AFK_TIMEOUT_MS * 0.6);

    assert.equal(playerOf(room, 'p1').idle, false);
  });
});

describe('an abandoned room does not play itself', () => {
  it('holds the gate shut when everyone has idled out without readying', () => {
    // With idled players merely skipped, a room nobody is left in would find "nobody is
    // blocking" vacuously true and march through fifteen waves to a loss unwatched.
    const { room, advance } = twoPlayerRoom();
    advance(AFK_TIMEOUT_MS + TICK_MS);

    assert.equal(playerOf(room, 'p1').idle, true);
    assert.equal(playerOf(room, 'p2').idle, true);
    assert.equal(allPlayersReady(room.state), false, 'nobody asked for this');
    assert.equal(room.state.phase, PHASE.LOBBY, 'no game may start in an empty-headed room');
  });

  it('still honours a player who readied and then went quiet', () => {
    // Readying is a decision, not a heartbeat. A team that all readies and then talks
    // for a minute must not deadlock waiting for someone to wiggle the mouse.
    const { room, advance } = twoPlayerRoom();
    room.enqueue('ca', { type: 'ready', value: true });
    room.enqueue('cb', { type: 'ready', value: true });
    advance(TICK_MS * 2);
    assert.equal(room.state.phase, PHASE.BUILD);

    advance(AFK_TIMEOUT_MS + TICK_MS);
    assert.equal(playerOf(room, 'p1').idle, true, 'both have gone quiet');

    room.enqueue('ca', { type: 'ready', value: true });
    room.enqueue('cb', { type: 'ready', value: true });
    advance(TICK_MS * 2);

    assert.equal(room.state.phase, PHASE.WAVE, 'their readiness still counts');
  });
});

describe('idle and disconnected are different things', () => {
  it('does not mark a disconnected player idle while their seat is held', () => {
    // They are already excluded from the gate by being disconnected, and their seat is
    // on the reconnect clock. Idling them too would double-count and muddle the roster.
    const { room, advance } = twoPlayerRoom();
    room.disconnect('cb', 0);

    advance(RECONNECT_GRACE_MS * 0.9);

    assert.equal(playerOf(room, 'p2').connected, false);
    assert.equal(playerOf(room, 'p2').idle, false);
  });

  it('frees the seat rather than idling it, once the grace period lapses', () => {
    const { room, advance } = twoPlayerRoom();
    room.disconnect('cb', 0);

    advance(RECONNECT_GRACE_MS + TICK_MS);

    assert.equal(room.state.players.has('p2'), false, 'the seat expires, it does not idle');
  });

  it('does not idle out a player who reconnects after a long absence', () => {
    const { room, advance, clock } = twoPlayerRoom();
    room.disconnect('cb', 0);
    advance(AFK_TIMEOUT_MS * 0.9);

    const back = room.join(
      { id: 'cb2', send: () => {} },
      'token-2',
      clock.now,
    );
    assert.equal(back.role, 'player');
    advance(TICK_MS * 2);

    assert.equal(playerOf(room, 'p2').idle, false, 'reconnecting is itself activity');
  });
});

describe('the roster tells players what is happening', () => {
  it('publishes a countdown that shrinks as the timeout approaches', () => {
    const { room, advance, clock } = twoPlayerRoom();
    advance(TICK_MS);

    const early = room.roster().players.find((/** @type {any} */ p) => p.playerId === 'p1');
    assert.ok(typeof early.afkInMs === 'number');

    const before = early.afkInMs;
    advance(AFK_TIMEOUT_MS / 2);
    const later = room.roster().players.find((/** @type {any} */ p) => p.playerId === 'p1');

    assert.ok(later.afkInMs < before, `countdown must fall: ${before} -> ${later.afkInMs}`);
    assert.ok(clock.now > 0);
  });

  it('reports whole seconds, not milliseconds nobody can read', () => {
    const { room, advance } = twoPlayerRoom();
    advance(TICK_MS * 3);

    const entry = room.roster().players.find((/** @type {any} */ p) => p.playerId === 'p1');
    assert.equal(entry.afkInMs % 1000, 0);
  });

  it('marks an idled player and stops counting down for them', () => {
    const { room, advance } = twoPlayerRoom();
    advance(AFK_TIMEOUT_MS + TICK_MS);

    const entry = room.roster().players.find((/** @type {any} */ p) => p.playerId === 'p1');
    assert.equal(entry.idle, true);
    assert.equal(entry.afkInMs, null, 'there is nothing left to count down to');
  });

  it('does not count down for someone who is not connected', () => {
    const { room, advance } = twoPlayerRoom();
    room.disconnect('cb', 0);
    advance(TICK_MS);

    const entry = room.roster().players.find((/** @type {any} */ p) => p.playerId === 'p2');
    assert.equal(entry.afkInMs, null);
  });
});
