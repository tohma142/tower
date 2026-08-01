/**
 * Client entry point: connect, render, and turn clicks into intents.
 *
 * The client simulates nothing. It draws what the server sent and asks for things it
 * would like to happen. The single exception is the placement ghost under the cursor,
 * which is drawn before confirmation and removed the moment a snapshot or a rejection
 * arrives — the smallest amount of optimism that stops the game feeling laggy.
 */

import {
  MAX_TOWER_LEVEL,
  PHASE,
  RENDER_DELAY_MS,
  RENDER_SCALE,
  TOWER_TYPES,
  sellRefundFor,
  upgradeCostFor,
} from '../shared/constants.js';
import { isBuildable } from '../shared/map.js';

import { log, setLogLevel } from './log.js';
import { createConnection } from './net.js';
import { createConfirm } from './render/confirm.js';
import { drawBoard, drawEntities, drawGhost, drawTowerRanges } from './render/draw.js';
import { createHud, describeEvent } from './render/hud.js';
import { sampleAt } from './render/interpolate.js';
import { createUnitPanel } from './render/panel.js';
import { compileAll } from './render/sprites.js';
import { cardTitle, statLines } from './render/stats.js';
import { canvasSize, eventToTile, tilePixels } from './render/view.js';

setLogLevel(new URLSearchParams(location.search).get('log'));

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('board'));
const context2d = canvas.getContext('2d');
if (context2d === null) throw new Error('this browser cannot provide a 2d canvas context');
const ctx = /** @type {CanvasRenderingContext2D} */ (context2d);

const backing = canvasSize(RENDER_SCALE);
canvas.width = backing.width;
canvas.height = backing.height;
ctx.imageSmoothingEnabled = false;

const sprites = compileAll(RENDER_SCALE);
const hud = createHud(document);
const panel = createUnitPanel(document);

/** Two clicks to restart. See `confirm.js` for why there is no timer. */
const restartConfirm = createConfirm();

/** The room code from `/r/CODE`, or null on `/` meaning "make me one". */
const roomFromUrl = /^\/r\/([A-Z0-9]+)\/?$/.exec(location.pathname)?.[1] ?? null;

/** @type {{ selectedTower: string | null, selectedTile: { x: number, y: number } | null, hoverTile: { x: number, y: number } | null, roster: any, latestView: import('../game/state.js').Snapshot | null, ready: boolean }} */
const ui = {
  selectedTower: null,
  /** A placed penguin the player has clicked, addressed by tile rather than by id.
   *  Tiles survive a penguin being sold and rebuilt; ids do not. */
  selectedTile: null,
  hoverTile: null,
  roster: { players: [], spectators: 0, waitingOn: [] },
  latestView: null,
  ready: false,
};

const connection = createConnection({
  roomCode: roomFromUrl,

  onWelcome(welcome) {
    hud.setRoomCode(welcome.roomCode);

    // Put the code in the address bar so the URL itself is the invite. replaceState
    // rather than pushState: this is the same page, not a navigation to undo.
    if (location.pathname !== `/r/${welcome.roomCode}`) {
      history.replaceState(null, '', `/r/${welcome.roomCode}`);
    }

    if (welcome.role === 'spectator') {
      hud.pushEvent('Watching — you will get a seat when this game ends');
    }
  },

  onRoster(roster) {
    ui.roster = roster;
    hud.updateRoster(roster, connection.playerId(), ui.latestView);
  },

  onEvent(event) {
    // No ghost cleanup needed on a rejection: the ghost is drawn from the cursor and
    // the latest snapshot every frame, so a refused purchase simply never becomes a
    // penguin. The player sees the reason in the log.
    const line = describeEvent(event, connection.playerId());
    if (line !== null) hud.pushEvent(line);

    // A refused placement puts the penguin back in your hand. Clicking a path tile
    // should cost you a click, not your selection — and the server echoes the original
    // request back, so this re-arms exactly what was tried rather than a guess.
    //
    // Only when nothing is armed: by the time a rejection arrives the player may have
    // chosen something else, and overriding a deliberate later choice with an undo of an
    // earlier mistake is worse than doing nothing.
    if (
      event.kind === 'commandRejected' &&
      event.request?.type === 'place' &&
      ui.selectedTower === null
    ) {
      ui.selectedTower = event.request.towerType;
      hud.setSelectedTower(ui.selectedTower);
    }
  },

  onRejected(reason) {
    hud.setOverlay({
      title: reason === 'roomNotFound' ? 'No such room' : 'Room is full',
      body:
        reason === 'roomNotFound'
          ? 'That room has ended or the code is wrong. Start a fresh game instead.'
          : 'This game already has four players and a full gallery.',
      action: 'Start a new game',
    });
    hud.elements.overlayAction.onclick = () => {
      location.href = '/';
    };
  },

  onStatus(status) {
    hud.setStatus(status);
  },
});

// --- input -------------------------------------------------------------------

hud.buildShop((id) => {
  ui.selectedTower = ui.selectedTower === id ? null : id;
  // Buying and inspecting are different modes; leaving a penguin selected while a shop
  // item is armed would leave two panels claiming the next click.
  if (ui.selectedTower !== null) ui.selectedTile = null;
  hud.setSelectedTower(ui.selectedTower);
});
hud.setSelectedTower(null);
panel.hide();

panel.elements.upgradeButton.addEventListener('click', () => {
  if (ui.selectedTile === null) return;
  connection.send({ type: 'upgrade', tileX: ui.selectedTile.x, tileY: ui.selectedTile.y });
});

panel.elements.sellButton.addEventListener('click', () => {
  if (ui.selectedTile === null) return;
  connection.send({ type: 'sell', tileX: ui.selectedTile.x, tileY: ui.selectedTile.y });
  // Cleared optimistically: the tile is about to be empty, and the next frame reconciles
  // against the snapshot anyway if the server refuses.
  ui.selectedTile = null;
});

canvas.addEventListener('mousemove', (event) => {
  ui.hoverTile = eventToTile(event, canvas.getBoundingClientRect(), backing, RENDER_SCALE);
});

canvas.addEventListener('mouseleave', () => {
  ui.hoverTile = null;
});

canvas.addEventListener('click', (event) => {
  const tile = eventToTile(event, canvas.getBoundingClientRect(), backing, RENDER_SCALE);
  if (tile === null) return;

  // With a shop item armed the click buys. Otherwise it inspects whatever is standing
  // there — and a click on bare ice clears the selection, which is how you get out.
  if (ui.selectedTower !== null) {
    connection.send({
      type: 'place',
      tileX: tile.x,
      tileY: tile.y,
      towerType: ui.selectedTower,
    });

    // Disarm on click rather than on confirmation. Waiting for the snapshot would leave
    // the shop armed for a tick and a half, which is long enough to double-place with a
    // quick second click — the exact thing this is meant to stop. A placement the server
    // then refuses re-arms itself; see onEvent.
    ui.selectedTower = null;
    hud.setSelectedTower(null);
    return;
  }

  ui.selectedTile = towerAtTile(ui.latestView, tile) === undefined ? null : tile;
});

hud.elements.readyButton.addEventListener('click', () => {
  ui.ready = !ui.ready;
  connection.send({ type: 'ready', value: ui.ready });
});

hud.elements.restartButton.addEventListener('click', () => {
  // Two clicks, because this ends the run for everyone in the room and there is no undo.
  // The armed state expires on its own — `updateRestartButton` reads it every frame — so
  // there is no timer here to leak or to cancel.
  if (restartConfirm.click(performance.now()) === 'confirmed') {
    connection.send({ type: 'playAgain' });
  }
});

hud.elements.copyLink.addEventListener('click', async () => {
  const code = connection.roomCode();
  if (code === null) return;
  const url = `${location.origin}/r/${code}`;

  try {
    await navigator.clipboard.writeText(url);
    hud.pushEvent('Invite link copied');
  } catch {
    // Clipboard access needs a secure context and permission; showing the link is a
    // perfectly good fallback and better than a silent no-op.
    hud.pushEvent(`Invite link: ${url}`);
  }
});

// Keyboard shortcuts: 1..3 pick a penguin, Escape clears, Space readies.
window.addEventListener('keydown', (event) => {
  if (event.repeat) return;

  const towerIds = Object.keys(TOWER_TYPES);
  const index = Number(event.key) - 1;
  if (Number.isInteger(index) && index >= 0 && index < towerIds.length) {
    ui.selectedTower = towerIds[index];
    hud.setSelectedTower(ui.selectedTower);
    return;
  }

  if (event.key === 'Escape') {
    ui.selectedTower = null;
    ui.selectedTile = null;
    hud.setSelectedTower(null);
    return;
  }

  if (event.code === 'Space') {
    event.preventDefault();
    hud.elements.readyButton.click();
  }
});

// --- render loop -------------------------------------------------------------

/**
 * Whether the ghost under the cursor could legally be placed.
 *
 * Board rules only — the server owns affordability and occupancy, and disagreeing with
 * it here would show a green preview for a purchase that is then refused.
 *
 * @param {{ x: number, y: number }} tile
 * @param {import('../game/state.js').Snapshot | null} view
 * @returns {boolean}
 */
function ghostAllowed(tile, view) {
  if (!isBuildable(tile.x, tile.y)) return false;
  if (view === null) return true;
  return !view.towers.some((tower) => tower.x === tile.x && tower.y === tile.y);
}

/**
 * The penguin standing on a tile in a given snapshot, if any.
 *
 * @param {import('../game/state.js').Snapshot | null} view
 * @param {{ x: number, y: number }} tile
 * @returns {import('../game/state.js').SnapshotTower | undefined}
 */
function towerAtTile(view, tile) {
  return view?.towers.find((t) => t.x === tile.x && t.y === tile.y);
}

/**
 * Reconcile the selection panel against the authoritative world.
 *
 * Driven from the snapshot every frame rather than latched at click time, because the
 * selected penguin changes without this client doing anything: another player can upgrade
 * it, or sell it out from under you. A latched panel would show a stale level, or offer to
 * sell an empty tile.
 *
 * @param {import('../game/state.js').Snapshot} view
 * @returns {void}
 */
function updateSelection(view) {
  // A penguin armed in the shop previews itself under the cursor. No buttons: there is
  // nothing placed yet to upgrade or sell.
  if (ui.selectedTower !== null && ui.hoverTile !== null) {
    const spec = TOWER_TYPES[ui.selectedTower];
    if (spec === undefined) {
      panel.hide();
      return;
    }

    panel.show({
      tile: ui.hoverTile,
      title: cardTitle(spec, 1),
      lines: statLines(spec, 1),
      tilePxBacking: tilePixels(RENDER_SCALE),
      actions: null,
    });
    return;
  }

  if (ui.selectedTile === null) {
    panel.hide();
    return;
  }

  const tower = towerAtTile(view, ui.selectedTile);
  if (tower === undefined) {
    ui.selectedTile = null;
    panel.hide();
    return;
  }

  const spec = TOWER_TYPES[tower.type];
  if (spec === undefined) {
    panel.hide();
    return;
  }

  const atCap = tower.level >= MAX_TOWER_LEVEL;
  const cost = atCap ? null : upgradeCostFor(spec, tower.level);
  const me = view.players.find((p) => p.id === connection.playerId());
  const affordable = cost !== null && me !== undefined && me.fish >= cost;

  // Upgrading and selling are both build actions like placing, so they follow the same
  // phase rule; a spectator has no wallet to spend or be refunded into.
  const canEdit =
    connection.role() === 'player' &&
    (view.phase === PHASE.BUILD || view.phase === PHASE.WAVE);

  panel.show({
    tile: ui.selectedTile,
    title: cardTitle(spec, tower.level),
    lines: statLines(spec, tower.level),
    tilePxBacking: tilePixels(RENDER_SCALE),
    actions: {
      upgrade: atCap ? 'Fully upgraded' : `Upgrade (${cost} fish)`,
      // Disabled on price as well as on the cap, so the button never invites a click the
      // server is certain to refuse.
      upgradeEnabled: !atCap && affordable && canEdit,
      // Read off `invested`, so an upgraded penguin quotes a refund that includes what
      // the upgrades cost. Deriving it from the base price here would under-quote the
      // button and disagree with what the server actually pays.
      sell: `Sell (+${sellRefundFor(tower.invested)} fish)`,
      sellEnabled: canEdit,
    },
  });
}

/**
 * @param {import('../game/state.js').Snapshot} view
 * @returns {void}
 */
function updateReadyButton(view) {
  const isPlayer = connection.role() === 'player';
  const canReady = isPlayer && (view.phase === PHASE.LOBBY || view.phase === PHASE.BUILD);

  const me = view.players.find((p) => p.id === connection.playerId());
  if (me !== undefined) ui.ready = me.ready;

  const label =
    view.phase === PHASE.LOBBY
      ? ui.ready ? 'Waiting for others…' : 'Start game'
      : view.phase === PHASE.BUILD
        ? ui.ready ? 'Waiting for others…' : 'Send next wave'
        : view.phase === PHASE.WAVE ? 'Wave in progress' : 'Game over';

  hud.setReady(ui.ready, canReady, isPlayer ? label : 'Spectating');
}

/**
 * Draw the Restart button, including letting an armed confirmation lapse.
 *
 * Disabled in the lobby: there is no run to abandon, and offering it there would suggest
 * it clears what you have built, which it does not.
 *
 * @param {import('../game/state.js').Snapshot} view
 * @returns {void}
 */
function updateRestartButton(view) {
  const enabled = connection.role() === 'player' && view.phase !== PHASE.LOBBY;

  // A confirmation that is no longer offerable must not stay armed behind a disabled
  // button, waiting to fire on the next click whenever that turns out to be.
  if (!enabled) restartConfirm.reset();

  hud.setRestart(restartConfirm.isArmed(performance.now()), enabled);
}

/**
 * @param {import('../game/state.js').Snapshot} view
 * @returns {void}
 */
function updateOverlay(view) {
  if (view.phase !== PHASE.GAME_OVER) {
    hud.setOverlay(null);
    return;
  }

  const won = view.outcome === 'win';
  hud.setOverlay({
    title: won ? 'The iceberg holds' : 'The iceberg is gone',
    body: won
      ? `All ${view.totalWaves} waves turned back. ${view.kills} enemies stopped.`
      : `Defeat on wave ${view.wave} of ${view.totalWaves}. ${view.kills} enemies stopped, ${view.leaks} got through.`,
    action: connection.role() === 'player' ? 'Play again' : undefined,
  });

  hud.elements.overlayAction.onclick = () => connection.send({ type: 'playAgain' });
}

/** @type {string | null} */
let lastRosterView = null;

/**
 * Draw one frame.
 *
 * Renders `RENDER_DELAY_MS` in the past and interpolates, which is what turns a 20 Hz
 * simulation into smooth motion. See `interpolate.js`.
 *
 * @returns {void}
 */
function frame() {
  requestAnimationFrame(frame);

  const view = sampleAt(connection.buffer, performance.now() - RENDER_DELAY_MS);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawBoard(ctx, RENDER_SCALE);

  if (view === null) return;
  ui.latestView = view;

  if (ui.selectedTower !== null || ui.selectedTile !== null) {
    drawTowerRanges(ctx, view, RENDER_SCALE);
  }

  drawEntities(ctx, view, sprites, RENDER_SCALE, ui.roster.players.map((/** @type {any} */ p) => p.playerId));

  if (ui.selectedTower !== null && ui.hoverTile !== null) {
    drawGhost(
      ctx,
      {
        tile: ui.hoverTile,
        towerType: ui.selectedTower,
        allowed: ghostAllowed(ui.hoverTile, view),
      },
      sprites.penguins,
      RENDER_SCALE,
    );
  }

  // The panel is DOM over the canvas rather than part of this drawing pass, so it is
  // updated with the rest of the HUD below rather than here.
  hud.updateVitals(view, connection.playerId());
  updateSelection(view);
  updateReadyButton(view);
  updateRestartButton(view);
  updateOverlay(view);

  // The roster shows per-player fish and ready state, which change every tick — but
  // rebuilding that list 60 times a second would churn the DOM for nothing.
  const rosterSignature = view.players.map((p) => `${p.id}:${p.fish}:${p.ready}`).join('|');
  if (rosterSignature !== lastRosterView) {
    lastRosterView = rosterSignature;
    hud.updateRoster(ui.roster, connection.playerId(), view);
  }
}

requestAnimationFrame(frame);
log.info('client started', { room: roomFromUrl ?? '(new)' });
