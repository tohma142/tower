/**
 * The HUD.
 *
 * Text lives in the DOM rather than on the canvas: it stays selectable, scales with the
 * browser's font settings, and does not need to be re-laid-out by hand every frame.
 *
 * `describeEvent` is exported separately and kept pure, because turning a server event
 * into a sentence is the one part of this file worth testing.
 */

import { ENEMY_TYPES, TOWER_TYPES, isCombatTower } from '../../shared/constants.js';

import { statLines } from './stats.js';

/**
 * Turn a server event into a line for the log, or null if it is not worth showing.
 *
 * Pure, and deliberately unaware of the DOM.
 *
 * @param {any} event
 * @param {string | null} playerId Used to word rejections as second person.
 * @returns {string | null}
 */
export function describeEvent(event, playerId = null) {
  switch (event.kind) {
    case 'waveStarted':
      return `Wave ${event.wave} incoming`;

    case 'waveCleared':
      // The bonus is a real part of the economy — a player who cannot see it arriving
      // has no way to plan around it.
      // Fisher income is reported separately from the survival bonus rather than summed,
      // because they answer different questions: one is what surviving pays, the other
      // is what your investment paid, and a player deciding whether to build another
      // Fisher needs the second number on its own.
      return describeWaveCleared(event);

    case 'leak':
      // The event carries the type id; the player should see the creature's name. Same
      // rule as the rejection reasons — internal vocabulary never reaches the screen.
      return `A ${ENEMY_TYPES[event.enemyType]?.name ?? event.enemyType} reached the iceberg (-${event.damage})`;

    case 'gameOver':
      return event.outcome === 'win'
        ? 'The iceberg holds. You win.'
        : `The iceberg is gone. Defeat on wave ${event.wave}.`;

    case 'towerUpgraded':
      return `${TOWER_TYPES[event.towerType]?.name ?? event.towerType} upgraded to level ${event.level} (-${event.cost} fish)`;

    case 'towerSold':
      // Named by display name, not type id, on the same rule as the leak line above.
      return `${TOWER_TYPES[event.towerType]?.name ?? event.towerType} sold (+${event.refund} fish)`;

    case 'gameStarted':
      return 'Game started — build your defences';

    case 'returnedToLobby':
      return 'Back to the lobby';

    case 'commandRejected':
      return describeRejection(event.reason, playerId);

    case 'protocolError':
      return `Protocol error: ${event.reason}`;

    default:
      return null;
  }
}

/**
 * @param {any} event
 * @returns {string}
 */
function describeWaveCleared(event) {
  const parts = [];
  if (event.bonus > 0) parts.push(`+${event.bonus} fish each`);
  if (event.income > 0) parts.push(`+${event.income} from your Fishers`);

  return parts.length === 0
    ? `Wave ${event.wave} cleared`
    : `Wave ${event.wave} cleared (${parts.join(', ')})`;
}

/**
 * @param {string} reason
 * @param {string | null} playerId
 * @returns {string}
 */
function describeRejection(reason, playerId) {
  // Branching on the reason constant, never on message text — the text is free to change.
  switch (reason) {
    case 'insufficientFish': return 'Not enough fish';
    case 'tileOccupied': return 'A penguin is already there';
    case 'tileNotBuildable': return 'Enemies walk over that tile';
    case 'outOfBounds': return 'That is off the board';
    case 'wrongPhase': return 'Not right now';
    case 'notAPlayer': return playerId === null ? 'Spectators cannot build' : 'You are not seated';
    case 'unknownTowerType': return 'No such penguin';
    case 'noTowerHere': return 'No penguin on that tile';
    case 'alreadyMaxLevel': return 'That penguin is fully upgraded';

    // These two normally arrive as a connection-level rejection and are shown on the
    // overlay rather than in the log. They are worded here anyway: the constant exists,
    // and a reason with no sentence would put raw internal vocabulary in front of a
    // player the day anything starts routing them through here.
    case 'roomNotFound': return 'That game has ended, or the code is wrong';
    case 'roomFull': return 'That game is already full';

    default: return `Refused: ${reason}`;
  }
}

/** Lines kept in the event log. Older ones are simply gone. */
const MAX_LOG_LINES = 8;

/**
 * Wire up the HUD against the document.
 *
 * @param {Document} doc
 * @returns {ReturnType<typeof buildHud>}
 */
export function createHud(doc) {
  return buildHud(doc);
}

/**
 * @param {Document} doc
 */
function buildHud(doc) {
  /**
   * @param {string} id
   * @returns {HTMLElement}
   */
  const el = (id) => {
    const found = doc.getElementById(id);
    if (found === null) throw new Error(`missing HUD element: #${id}`);
    return /** @type {HTMLElement} */ (found);
  };

  const roomCode = el('room-code');
  const status = el('status');
  const icebergFill = el('iceberg-fill');
  const icebergText = el('iceberg-text');
  const waveText = el('wave-text');
  const fishText = el('fish-text');
  const rosterList = el('roster');
  const waitingOn = el('waiting-on');
  const eventLog = el('event-log');
  const readyButton = /** @type {HTMLButtonElement} */ (el('ready'));
  const shopButtons = el('shop-buttons');
  const shopHint = el('shop-hint');
  const shopStats = el('shop-stats');
  const overlay = el('overlay');
  const overlayTitle = el('overlay-title');
  const overlayBody = el('overlay-body');
  const overlayAction = /** @type {HTMLButtonElement} */ (el('overlay-action'));

  return {
    elements: {
      readyButton,
      shopButtons,
      overlayAction,
      copyLink: el('copy-link'),
    },

    /** @param {string} code */
    setRoomCode(code) {
      roomCode.textContent = code;
    },

    /** @param {'connecting' | 'online' | 'offline'} value */
    setStatus(value) {
      status.dataset.status = value;
      status.textContent =
        value === 'online' ? 'Connected' : value === 'connecting' ? 'Connecting…' : 'Reconnecting…';
    },

    /**
     * Build the shop from the tuning table, so adding a penguin needs no HTML edit.
     *
     * @param {(id: string) => void} onSelect
     * @returns {void}
     */
    buildShop(onSelect) {
      shopButtons.replaceChildren();
      for (const [id, spec] of Object.entries(TOWER_TYPES)) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'shop-button';
        button.dataset.tower = id;
        button.setAttribute('aria-pressed', 'false');
        button.title = isCombatTower(spec)
          ? `range ${spec.range}, damage ${spec.damage}, ${spec.fireRate}/sec`
          : `+${spec.income} fish to every player each wave`;

        const name = doc.createElement('span');
        name.textContent = spec.name;
        const cost = doc.createElement('span');
        cost.className = 'cost';
        cost.textContent = `${spec.cost}`;

        button.append(name, cost);
        button.addEventListener('click', () => onSelect(id));
        shopButtons.append(button);
      }
    },

    /** @param {string | null} selected */
    setSelectedTower(selected) {
      for (const button of shopButtons.querySelectorAll('button')) {
        const isSelected = button.dataset.tower === selected;
        button.setAttribute('aria-pressed', String(isSelected));
      }
      shopHint.textContent = selected === null
        ? 'Pick a penguin, then click a tile.'
        : `Click a tile to place the ${TOWER_TYPES[selected]?.name ?? selected}.`;

      // The same rows the board card shows, so a player can compare two units without
      // hovering the board — and so the two readouts can never disagree.
      const spec = selected === null ? undefined : TOWER_TYPES[selected];
      shopStats.replaceChildren();
      shopStats.hidden = spec === undefined;
      if (spec !== undefined) {
        for (const { label, value } of statLines(spec, 1)) {
          const dt = doc.createElement('dt');
          dt.textContent = label;
          const dd = doc.createElement('dd');
          dd.textContent = value;
          shopStats.append(dt, dd);
        }
      }
    },

    /**
     * @param {import('../../game/state.js').Snapshot} view
     * @param {string | null} playerId
     * @returns {void}
     */
    updateVitals(view, playerId) {
      const fraction = view.icebergMaxHp === 0 ? 0 : view.icebergHp / view.icebergMaxHp;
      icebergFill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
      icebergText.textContent = `${Math.ceil(view.icebergHp)} / ${view.icebergMaxHp}`;

      waveText.textContent =
        view.wave === 0 ? 'Lobby' : `${view.wave} / ${view.totalWaves}`;

      const me = view.players.find((p) => p.id === playerId);
      fishText.textContent = me === undefined ? '—' : `${me.fish}`;
    },

    /**
     * @param {any} roster
     * @param {string | null} playerId
     * @param {import('../../game/state.js').Snapshot | null} view
     * @returns {void}
     */
    updateRoster(roster, playerId, view) {
      rosterList.replaceChildren();

      for (const entry of roster.players) {
        const item = doc.createElement('li');
        item.dataset.connected = String(entry.connected);
        item.dataset.you = String(entry.playerId === playerId);

        const who = doc.createElement('span');
        who.className = 'who';
        who.textContent = entry.name;

        const state = doc.createElement('span');
        const player = view?.players.find((p) => p.id === entry.playerId);
        if (!entry.connected) {
          state.textContent = 'away';
        } else if (player?.ready) {
          state.className = 'ready';
          state.textContent = 'ready';
        } else {
          state.textContent = player === undefined ? '' : `${player.fish}`;
        }

        item.append(who, state);
        rosterList.append(item);
      }

      // The ready gate has no timeout, so naming who everyone is waiting on is the only
      // thing that keeps an idle player from silently stalling the room.
      waitingOn.textContent =
        roster.waitingOn.length === 0
          ? roster.spectators > 0 ? `${roster.spectators} watching` : ''
          : `Waiting on ${roster.waitingOn.join(', ')}`;
    },

    /** @param {string} text */
    pushEvent(text) {
      const item = doc.createElement('li');
      item.textContent = text;
      eventLog.prepend(item);
      while (eventLog.childElementCount > MAX_LOG_LINES) {
        eventLog.lastElementChild?.remove();
      }
    },

    /**
     * @param {boolean} ready
     * @param {boolean} enabled
     * @param {string} label
     * @returns {void}
     */
    setReady(ready, enabled, label) {
      readyButton.setAttribute('aria-pressed', String(ready));
      readyButton.disabled = !enabled;
      readyButton.textContent = label;
    },

    /**
     * @param {{ title: string, body: string, action?: string } | null} content
     * @returns {void}
     */
    setOverlay(content) {
      if (content === null) {
        overlay.hidden = true;
        return;
      }
      overlay.hidden = false;
      overlayTitle.textContent = content.title;
      overlayBody.textContent = content.body;
      overlayAction.hidden = content.action === undefined;
      if (content.action !== undefined) overlayAction.textContent = content.action;
    },
  };
}
