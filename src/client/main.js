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
  upgradeCostFor,
} from '../shared/constants.js';
import { isBuildable } from '../shared/map.js';

import { log, setLogLevel } from './log.js';
import { createConnection } from './net.js';
import { drawBoard, drawEntities, drawGhost, drawTowerRanges } from './render/draw.js';
import { createHud, describeEvent } from './render/hud.js';
import { sampleAt } from './render/interpolate.js';
import { compileAll } from './render/sprites.js';
import { canvasSize, eventToTile } from './render/view.js';

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

/** The room code from `/r/CODE`, or null on `/` meaning "make me one". */
const roomFromUrl = /^\/r\/([A-Z0-9]+)\/?$/.exec(location.pathname)?.[1] ?? null;

/** @type {{ selectedTower: string | null, selectedTile: { x: number, y: number } | null, hoverTile: { x: number, y: number } | null, roster: any, latestView: import('../game/state.js').Snapshot | null, ready: boolean }} */
const ui = {
  selectedTower: null,
  /** A placed penguin the player has clicked, addressed by tile rather than by id. */
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
hud.setSelection(null);

hud.elements.upgradeButton.addEventListener('click', () => {
  if (ui.selectedTile === null) return;
  connection.send({ type: 'upgrade', tileX: ui.selectedTile.x, tileY: ui.selectedTile.y });
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
    return;
  }

  ui.selectedTile = towerAtTile(ui.latestView, tile) === undefined ? null : tile;
});

hud.elements.readyButton.addEventListener('click', () => {
  ui.ready = !ui.ready;
  connection.send({ type: 'ready', value: ui.ready });
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
 * Driven from the snapshot every frame rather than latched at click time: another player
 * can upgrade the penguin you have selected, and the panel has to show what is true
 * rather than what this client last saw.
 *
 * @param {import('../game/state.js').Snapshot} view
 * @returns {void}
 */
function updateSelection(view) {
  if (ui.selectedTile === null) {
    hud.setSelection(null);
    return;
  }

  const tower = towerAtTile(view, ui.selectedTile);
  if (tower === undefined) {
    ui.selectedTile = null;
    hud.setSelection(null);
    return;
  }

  const spec = TOWER_TYPES[tower.type];
  const atCap = tower.level >= MAX_TOWER_LEVEL;
  const cost = atCap || spec === undefined ? null : upgradeCostFor(spec, tower.level);
  const me = view.players.find((p) => p.id === connection.playerId());

  hud.setSelection({
    name: spec?.name ?? tower.type,
    level: tower.level,
    maxLevel: MAX_TOWER_LEVEL,
    cost,
    affordable: cost !== null && me !== undefined && me.fish >= cost,
    canEdit:
      connection.role() === 'player' &&
      (view.phase === PHASE.BUILD || view.phase === PHASE.WAVE),
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

  if (ui.selectedTower !== null) drawTowerRanges(ctx, view, RENDER_SCALE);

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

  hud.updateVitals(view, connection.playerId());
  updateSelection(view);
  updateReadyButton(view);
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
