import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_PLAYERS,
  MAX_SPECTATORS,
  PHASE,
  RECONNECT_GRACE_MS,
  TICK_MS,
} from '../../src/shared/constants.js';
import { REJECT_REASON, SERVER_MSG } from '../../src/shared/protocol.js';
import { player } from '../helpers/game.js';
import { fakeConnection, makeRoom, seat } from '../helpers/server.js';

/**
 * Ready every seated player and tick, which is what advances the gate.
 *
 * @param {import('../../src/server/room.js').Room} room
 * @param {string[]} connectionIds
 * @param {number} [nowMs]
 */
function readyAll(room, connectionIds, nowMs = 0) {
  for (const id of connectionIds) {
    room.enqueue(id, { type: 'ready', value: true });
  }
  room.tick(nowMs, TICK_MS);
}

describe('joining', () => {
  it('seats the first arrivals as players', () => {
    const { room } = makeRoom();
    const { join } = seat(room, 'c1');

    assert.equal(join.role, 'player');
    assert.equal(join.playerId, 'p1');
    assert.equal(room.seatCount, 1);
  });

  it('names players in seat order', () => {
    const { room } = makeRoom();
    seat(room, 'c1');
    seat(room, 'c2');

    assert.deepEqual(room.roster().players.map((p) => p.name), ['Penguin 1', 'Penguin 2']);
  });

  it('seats up to the player cap', () => {
    const { room } = makeRoom();
    for (let i = 0; i < MAX_PLAYERS; i += 1) seat(room, `c${i}`);

    assert.equal(room.seatCount, MAX_PLAYERS);
  });

  it('makes arrivals beyond the cap spectators', () => {
    const { room } = makeRoom();
    for (let i = 0; i < MAX_PLAYERS; i += 1) seat(room, `c${i}`);

    const extra = fakeConnection('extra');
    const join = room.join(extra, undefined, 0);

    assert.equal(join.ok, true);
    assert.equal(join.role, 'spectator');
    assert.equal(room.seatCount, MAX_PLAYERS);
  });

  it('makes anyone arriving after the game starts a spectator', () => {
    // There is no sensible fish balance for a wave-12 arrival, so late joiners watch.
    const { room } = makeRoom();
    seat(room, 'c1');
    readyAll(room, ['c1']);
    assert.notEqual(room.state.phase, PHASE.LOBBY);

    const late = fakeConnection('late');
    assert.equal(room.join(late, undefined, 0).role, 'spectator');
  });

  it('refuses once even the spectator gallery is full', () => {
    const { room } = makeRoom();
    for (let i = 0; i < MAX_PLAYERS; i += 1) seat(room, `p${i}`);
    for (let i = 0; i < MAX_SPECTATORS; i += 1) {
      room.join(fakeConnection(`s${i}`), undefined, 0);
    }

    const result = room.join(fakeConnection('overflow'), undefined, 0);

    assert.equal(result.ok, false);
    assert.equal(result.reason, REJECT_REASON.ROOM_FULL);
  });

  it('does not count a refused connection as connected', () => {
    const { room } = makeRoom();
    for (let i = 0; i < MAX_PLAYERS; i += 1) seat(room, `p${i}`);
    for (let i = 0; i < MAX_SPECTATORS; i += 1) room.join(fakeConnection(`s${i}`), undefined, 0);

    const before = room.connectionCount;
    room.join(fakeConnection('overflow'), undefined, 0);

    assert.equal(room.connectionCount, before, 'a refused socket must not be tracked');
  });
});

describe('seat tokens', () => {
  it('never appear in the roster', () => {
    // The token is a reconnect credential. Anyone holding it can take the seat.
    const { room } = makeRoom();
    const { join } = seat(room, 'c1');

    const serialised = JSON.stringify(room.roster());

    assert.ok(join.seatToken);
    assert.equal(serialised.includes(join.seatToken), false, 'token leaked in roster');
  });

  it('never appear in a snapshot', () => {
    const { room } = makeRoom();
    const { join } = seat(room, 'c1');

    assert.ok(join.seatToken);
    assert.equal(JSON.stringify(room.snapshot()).includes(join.seatToken), false);
  });

  it('are unique per seat', () => {
    const { room } = makeRoom();
    const a = seat(room, 'c1');
    const b = seat(room, 'c2');

    assert.notEqual(a.join.seatToken, b.join.seatToken);
  });
});

describe('disconnect and reconnect', () => {
  it('holds the seat and its fish through the grace period', () => {
    const { room } = makeRoom();
    const { join } = seat(room, 'c1');
    player(room.state, 'p1').fish = 777;

    room.disconnect('c1', 1000);
    assert.equal(room.seatCount, 1, 'seat is held, not freed');

    const back = fakeConnection('c2');
    assert.ok(join.seatToken, 'a seated player must receive a token');
    const rejoin = room.join(back, join.seatToken, 2000);

    assert.equal(rejoin.role, 'player');
    assert.equal(rejoin.playerId, 'p1');
    assert.equal(player(room.state, 'p1').fish, 777, 'fish survived');
  });

  it('leaves their towers firing while they are away', () => {
    const { room } = makeRoom();
    seat(room, 'c1');
    readyAll(room, ['c1']);
    room.enqueue('c1', { type: 'place', tileX: 0, tileY: 0, towerType: 'pistol' });
    room.tick(0, TICK_MS);
    const towers = room.state.towers.length;
    assert.ok(towers > 0, 'setup: a tower should exist');

    room.disconnect('c1', 1000);
    room.tick(1000, TICK_MS);

    assert.equal(room.state.towers.length, towers);
  });

  it('frees the seat once the grace period expires', () => {
    const { room } = makeRoom();
    const { join } = seat(room, 'c1');

    room.disconnect('c1', 1000);
    room.tick(1000 + RECONNECT_GRACE_MS, TICK_MS);

    assert.equal(room.seatCount, 0);
    assert.equal(room.state.players.size, 0);

    // The stale token must not resurrect the seat.
    const late = fakeConnection('late');
    const result = room.join(late, join.seatToken, 1000 + RECONNECT_GRACE_MS + 1);
    assert.equal(result.playerId, 'p1', 'a fresh lobby seat, not the old one');
  });

  it('does not expire a seat one tick early', () => {
    const { room } = makeRoom();
    seat(room, 'c1');
    room.disconnect('c1', 1000);

    room.tick(1000 + RECONNECT_GRACE_MS - 1, TICK_MS);

    assert.equal(room.seatCount, 1);
  });

  it('lets a reconnecting player back in even when the room looks full', () => {
    // Their own empty seat is what makes it look full; demoting them to spectator
    // because of it would be perverse.
    const { room } = makeRoom();
    const seats = [];
    for (let i = 0; i < MAX_PLAYERS; i += 1) seats.push(seat(room, `c${i}`));
    for (let i = 0; i < MAX_SPECTATORS; i += 1) room.join(fakeConnection(`s${i}`), undefined, 0);

    room.disconnect('c0', 1000);
    const result = room.join(fakeConnection('c0-again'), seats[0].join.seatToken, 1100);

    assert.equal(result.ok, true);
    assert.equal(result.role, 'player');
    assert.equal(result.playerId, 'p1');
  });

  it('drops commands queued by a connection that then vanished', () => {
    const { room } = makeRoom();
    seat(room, 'c1');
    readyAll(room, ['c1']);

    room.enqueue('c1', { type: 'place', tileX: 0, tileY: 0, towerType: 'pistol' });
    room.disconnect('c1', 100);
    room.tick(100, TICK_MS);

    assert.equal(room.state.towers.length, 0, 'a command must not land from a gone connection');
  });

  it('ignores an unrecognised seat token instead of trusting it', () => {
    const { room } = makeRoom();
    const result = room.join(fakeConnection('c1'), '00000000-0000-4000-8000-000000000000', 0);

    assert.equal(result.ok, true);
    assert.equal(result.role, 'player', 'falls through to a normal lobby seat');
    assert.equal(result.playerId, 'p1');
  });
});

describe('the ready gate', () => {
  it('starts the game once every connected player is ready', () => {
    const { room } = makeRoom();
    seat(room, 'c1');
    seat(room, 'c2');

    room.enqueue('c1', { type: 'ready', value: true });
    room.tick(0, TICK_MS);
    assert.equal(room.state.phase, PHASE.LOBBY, 'one player is not enough');

    room.enqueue('c2', { type: 'ready', value: true });
    room.tick(0, TICK_MS);
    assert.equal(room.state.phase, PHASE.BUILD);
  });

  it('is not stalled by a disconnected player', () => {
    // The gate has no timeout, so this exclusion is the only thing preventing one
    // dropped connection from freezing the room forever.
    const { room } = makeRoom();
    seat(room, 'c1');
    seat(room, 'c2');

    room.enqueue('c1', { type: 'ready', value: true });
    room.tick(0, TICK_MS);
    assert.equal(room.state.phase, PHASE.LOBBY);

    room.disconnect('c2', 100);
    room.tick(100, TICK_MS);

    assert.equal(room.state.phase, PHASE.BUILD, 'the remaining player can proceed');
  });

  it('will not start a game in an empty room', () => {
    const { room } = makeRoom();
    seat(room, 'c1');
    room.enqueue('c1', { type: 'ready', value: true });
    room.disconnect('c1', 10);

    room.tick(10, TICK_MS);

    assert.equal(room.state.phase, PHASE.LOBBY);
  });

  it('sends the next wave when everyone readies during the build phase', () => {
    const { room } = makeRoom();
    seat(room, 'c1');

    readyAll(room, ['c1']);
    assert.equal(room.state.phase, PHASE.BUILD, 'lobby ready starts the game, not wave 1');

    readyAll(room, ['c1']);
    assert.equal(room.state.phase, PHASE.WAVE);
    assert.equal(room.state.wave, 1);
  });

  it('reports who the room is waiting on', () => {
    const { room } = makeRoom();
    seat(room, 'c1');
    seat(room, 'c2');
    room.enqueue('c1', { type: 'ready', value: true });
    room.tick(0, TICK_MS);

    assert.deepEqual(room.roster().waitingOn, ['Penguin 2']);
  });
});

describe('commands', () => {
  it('applies in arrival order at the start of a tick, not on arrival', () => {
    // This is what makes two players clicking one tile deterministic rather than a
    // race against the event loop.
    const { room } = makeRoom();
    seat(room, 'c1');
    seat(room, 'c2');
    readyAll(room, ['c1', 'c2']);

    room.enqueue('c1', { type: 'place', tileX: 0, tileY: 0, towerType: 'pistol' });
    room.enqueue('c2', { type: 'place', tileX: 0, tileY: 0, towerType: 'pistol' });
    assert.equal(room.state.towers.length, 0, 'nothing applies until the tick');

    room.tick(0, TICK_MS);

    assert.equal(room.state.towers.length, 1);
    assert.equal(room.state.towers[0].ownerId, 'p1', 'first queued wins');
  });

  it('tells only the losing player their purchase was refused', () => {
    const { room } = makeRoom();
    const a = seat(room, 'c1');
    const b = seat(room, 'c2');
    readyAll(room, ['c1', 'c2']);

    room.enqueue('c1', { type: 'place', tileX: 0, tileY: 0, towerType: 'pistol' });
    room.enqueue('c2', { type: 'place', tileX: 0, tileY: 0, towerType: 'pistol' });
    room.tick(0, TICK_MS);

    /** @param {ReturnType<typeof fakeConnection>} conn */
    const rejections = (conn) =>
      conn.sent.filter((/** @type {any} */ m) => m.type === SERVER_MSG.EVENT && m.kind === 'commandRejected');

    assert.equal(rejections(a.conn).length, 0, 'the winner hears nothing');
    assert.equal(rejections(b.conn).length, 1);
    assert.equal(rejections(b.conn)[0].reason, REJECT_REASON.TILE_OCCUPIED);
  });

  it('refuses commands from spectators', () => {
    // Read-only must be read-only regardless of what the game would have allowed.
    const { room } = makeRoom();
    seat(room, 'c1');
    readyAll(room, ['c1']);

    const watcher = fakeConnection('watch');
    room.join(watcher, undefined, 0);
    room.enqueue('watch', { type: 'place', tileX: 0, tileY: 0, towerType: 'pistol' });
    room.tick(0, TICK_MS);

    assert.equal(room.state.towers.length, 0);
    assert.equal(watcher.last(SERVER_MSG.EVENT).reason, REJECT_REASON.NOT_A_PLAYER);
  });

  it('ignores commands from a connection that never joined', () => {
    const { room } = makeRoom();
    assert.doesNotThrow(() => room.enqueue('nobody', { type: 'ready', value: true }));
  });

  it('bounds the queue rather than growing without limit', () => {
    const { room } = makeRoom();
    seat(room, 'c1');

    for (let i = 0; i < 1000; i += 1) {
      room.enqueue('c1', { type: 'ready', value: true });
    }

    assert.doesNotThrow(() => room.tick(0, TICK_MS));
  });
});

describe('broadcasting', () => {
  it('sends a snapshot to every connection each tick', () => {
    const { room } = makeRoom();
    const a = seat(room, 'c1');
    const watcher = fakeConnection('watch');
    room.join(watcher, undefined, 0);

    room.tick(0, TICK_MS);

    assert.equal(a.conn.ofType(SERVER_MSG.SNAPSHOT).length, 1);
    assert.equal(watcher.ofType(SERVER_MSG.SNAPSHOT).length, 1, 'spectators see everything');
  });

  it('gives every connection the identical snapshot', () => {
    // The whole point of a server-authoritative design: two players cannot disagree.
    const { room } = makeRoom();
    const a = seat(room, 'c1');
    const b = seat(room, 'c2');
    readyAll(room, ['c1', 'c2']);
    readyAll(room, ['c1', 'c2']);

    for (let i = 0; i < 20; i += 1) room.tick(i * TICK_MS, TICK_MS);

    assert.deepEqual(a.conn.ofType(SERVER_MSG.SNAPSHOT), b.conn.ofType(SERVER_MSG.SNAPSHOT));
  });

  it('stops sending to a disconnected connection', () => {
    const { room } = makeRoom();
    const a = seat(room, 'c1');
    room.tick(0, TICK_MS);
    const before = a.conn.sent.length;

    room.disconnect('c1', 100);
    room.tick(100, TICK_MS);

    assert.equal(a.conn.sent.length, before);
  });
});

describe('game over and play again', () => {
  /**
   * Drive a room to defeat quickly by starting a wave and gutting the iceberg.
   *
   * @param {import('../../src/server/room.js').Room} room
   * @param {string[]} ids
   */
  function driveToDefeat(room, ids) {
    readyAll(room, ids);
    readyAll(room, ids);
    room.state.icebergHp = 1;
    for (let i = 0; i < 40_000 && room.state.phase !== PHASE.GAME_OVER; i += 1) {
      room.tick(i * TICK_MS, TICK_MS);
    }
  }

  it('reaches game over and reports the outcome', () => {
    const { room } = makeRoom();
    seat(room, 'c1');
    driveToDefeat(room, ['c1']);

    assert.equal(room.state.phase, PHASE.GAME_OVER);
    assert.equal(room.state.outcome, 'loss');
  });

  it('returns to the lobby on playAgain', () => {
    const { room } = makeRoom();
    seat(room, 'c1');
    driveToDefeat(room, ['c1']);

    room.enqueue('c1', { type: 'playAgain' });

    assert.equal(room.state.phase, PHASE.LOBBY);
  });

  it('abandons a game in progress on playAgain', () => {
    // This used to assert the opposite — playAgain was ignored unless the game was over.
    // That left a run that was clearly lost with no way out but closing the tab, which
    // strands everyone else in the room. The Restart button is the deliberate reversal;
    // the two-step confirm on it is what stops a stray click ending someone else's game.
    const { room } = makeRoom();
    seat(room, 'c1');
    readyAll(room, ['c1']);
    assert.equal(room.state.phase, PHASE.BUILD);

    room.enqueue('c1', { type: 'playAgain' });

    assert.equal(room.state.phase, PHASE.LOBBY);
  });

  it('abandons mid-wave, not only between waves', () => {
    // The moment a player most wants out is halfway through the wave that is killing
    // them, which is exactly when the board is busiest.
    const { room } = makeRoom();
    seat(room, 'c1');
    readyAll(room, ['c1']);
    readyAll(room, ['c1'], 100);
    // Far enough in that the wave has actually spawned something to abandon.
    for (let t = 200; t <= 2000; t += TICK_MS) room.tick(t, TICK_MS);
    assert.equal(room.state.phase, PHASE.WAVE);
    assert.ok(room.state.enemies.length > 0, 'nothing on the board to abandon');

    room.enqueue('c1', { type: 'playAgain' });

    assert.equal(room.state.phase, PHASE.LOBBY);
    assert.equal(room.state.enemies.length, 0, 'a reset must clear the board');
  });

  it('leaves a lobby alone', () => {
    // Nothing to abandon, and resetting would silently clear anything already built.
    const { room } = makeRoom();
    seat(room, 'c1');
    assert.equal(room.state.phase, PHASE.LOBBY);

    room.enqueue('c1', { type: 'playAgain' });

    assert.equal(room.state.phase, PHASE.LOBBY);
  });

  it('refuses a restart from someone with no seat', () => {
    // Spectators watch. Letting one end the game for four players would be griefing with
    // a single click.
    const { room } = makeRoom();
    seat(room, 'c1');
    readyAll(room, ['c1']);

    room.enqueue('nobody', { type: 'playAgain' });

    assert.equal(room.state.phase, PHASE.BUILD);
  });

  it('promotes a spectator into a free seat when the game ends', () => {
    // The only path from spectator to player, and the reason watching is worth doing.
    const { room } = makeRoom();
    seat(room, 'c1');
    readyAll(room, ['c1']);

    const watcher = fakeConnection('watch');
    assert.equal(room.join(watcher, undefined, 0).role, 'spectator');

    readyAll(room, ['c1']); // second ready sends wave 1; ticks do nothing in build
    room.state.icebergHp = 1;
    for (let i = 0; i < 40_000 && room.state.phase !== PHASE.GAME_OVER; i += 1) {
      room.tick(i * TICK_MS, TICK_MS);
    }
    room.enqueue('c1', { type: 'playAgain' });

    assert.equal(room.spectatorCount, 0);
    assert.equal(room.seatCount, 2);
    assert.equal(watcher.last(SERVER_MSG.WELCOME).role, 'player', 'promoted, and told so');
  });

  it('gives a promoted spectator their own seat token, privately', () => {
    const { room } = makeRoom();
    seat(room, 'c1');
    readyAll(room, ['c1']);
    const watcher = fakeConnection('watch');
    room.join(watcher, undefined, 0);

    readyAll(room, ['c1']); // second ready sends wave 1; ticks do nothing in build
    room.state.icebergHp = 1;
    for (let i = 0; i < 40_000 && room.state.phase !== PHASE.GAME_OVER; i += 1) {
      room.tick(i * TICK_MS, TICK_MS);
    }
    room.enqueue('c1', { type: 'playAgain' });

    const welcome = watcher.last(SERVER_MSG.WELCOME);
    assert.ok(welcome.seatToken, 'a promoted player needs a reconnect credential');
    assert.equal(JSON.stringify(room.roster()).includes(welcome.seatToken), false);
  });
});

describe('room lifetime', () => {
  it('is not expired while someone is connected', () => {
    const { room } = makeRoom();
    seat(room, 'c1');
    room.tick(0, TICK_MS);

    assert.equal(room.isExpired(1_000_000, 60_000), false);
  });

  it('expires once empty for longer than the idle window', () => {
    const { room } = makeRoom();
    seat(room, 'c1');
    room.tick(0, TICK_MS);
    room.disconnect('c1', 1000);

    assert.equal(room.isExpired(1000 + 59_999, 60_000), false);
    assert.equal(room.isExpired(1000 + 60_000, 60_000), true);
  });
});
