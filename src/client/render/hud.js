/**
 * The HUD.
 *
 * Text lives in the DOM rather than on the canvas: it stays selectable, scales with the
 * browser's font settings, and does not need to be re-laid-out by hand every frame.
 *
 * `describeEvent` is exported separately and kept pure, because turning a server event
 * into a sentence is the one part of this file worth testing.
 */

import { ENEMY_TYPES, TARGET_PRIORITY, TOWER_TYPES } from '../../shared/constants.js';

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
      return event.bonus > 0
        ? `Wave ${event.wave} cleared (+${event.bonus} fish each)`
        : `Wave ${event.wave} cleared`;

    case 'leak':
      // The event carries the type id; the player should see the creature's name. Same
      // rule as the rejection reasons — internal vocabulary never reaches the screen.
      return `A ${ENEMY_TYPES[event.enemyType]?.name ?? event.enemyType} reached the iceberg (-${event.damage})`;

    case 'gameOver':
      return event.outcome === 'win'
        ? 'The iceberg holds. You win.'
        : `The iceberg is gone. Defeat on wave ${event.wave}.`;

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

    // These two normally arrive as a connection-level rejection and are shown on the
    // overlay rather than in the log. They are worded here anyway: the constant exists,
    // and a reason with no sentence would put raw internal vocabulary in front of a
    // player the day anything starts routing them through here.
    case 'roomNotFound': return 'That game has ended, or the code is wrong';
    case 'roomFull': return 'That game is already full';

    default: return `Refused: ${reason}`;
  }
}

/**
 * Player-facing wording for each targeting rule.
 *
 * Exported and kept pure for the same reason `describeEvent` is: these strings are the
 * whole feature from the player's side, and "strongest" alone does not say strongest
 * *what*. A rule with no wording would put a raw constant on a button.
 *
 * @type {Readonly<Record<string, { label: string, hint: string }>>}
 */
export const TARGET_PRIORITY_LABELS = Object.freeze({
  [TARGET_PRIORITY.FIRST]: { label: 'First', hint: 'Whatever is closest to the iceberg' },
  [TARGET_PRIORITY.LAST]: { label: 'Last', hint: 'Whatever just arrived' },
  [TARGET_PRIORITY.STRONGEST]: { label: 'Strongest', hint: 'Whatever has the most health left' },
  [TARGET_PRIORITY.CLOSEST]: { label: 'Closest', hint: 'Whatever is nearest this penguin' },
});

/**
 * Wording for one targeting rule, falling back to the raw id.
 *
 * A newer server can add a rule this client has never heard of; showing the id beats
 * showing "undefined" on a button the player is about to press.
 *
 * @param {string} priority
 * @returns {{ label: string, hint: string }}
 */
export function describePriority(priority) {
  return TARGET_PRIORITY_LABELS[priority] ?? { label: priority, hint: '' };
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
  const selection = el('selection');
  const selectionName = el('selection-name');
  const targetButtons = el('target-buttons');
  const overlay = el('overlay');
  const overlayTitle = el('overlay-title');
  const overlayBody = el('overlay-body');
  const overlayAction = /** @type {HTMLButtonElement} */ (el('overlay-action'));

  return {
    elements: { readyButton, shopButtons, overlayAction, copyLink: el('copy-link') },

    /**
     * Build the targeting buttons once, from the constants rather than from HTML, so a
     * new rule needs no markup edit.
     *
     * @param {(priority: string) => void} onSelect
     * @returns {void}
     */
    buildTargetButtons(onSelect) {
      targetButtons.replaceChildren();
      for (const [id, { label, hint }] of Object.entries(TARGET_PRIORITY_LABELS)) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.dataset.priority = id;
        button.textContent = label;
        button.title = hint;
        button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', () => onSelect(id));
        targetButtons.append(button);
      }
    },

    /**
     * Show which penguin is selected and how it is currently targeting.
     *
     * @param {{ name: string, priority: string, canEdit: boolean } | null} content
     * @returns {void}
     */
    setSelection(content) {
      if (content === null) {
        selection.hidden = true;
        return;
      }
      selection.hidden = false;
      selectionName.textContent = content.name;
      for (const button of targetButtons.querySelectorAll('button')) {
        button.setAttribute('aria-pressed', String(button.dataset.priority === content.priority));
        button.disabled = !content.canEdit;
      }
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
        button.title = `range ${spec.range}, damage ${spec.damage}, ${spec.fireRate}/sec`;

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
