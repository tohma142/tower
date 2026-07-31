/**
 * The unit panel: the card that floats beside a penguin on the board.
 *
 * It does two jobs that used to be split between a canvas card and a sidebar section —
 * it reports a penguin's stats, and it carries the Upgrade and Sell buttons. Keeping them
 * together is the point: the numbers you are deciding on and the buttons that act on them
 * are the same thing, and putting them at opposite ends of the screen made you look twice.
 *
 * This is DOM rather than canvas because canvas has no buttons. Painting two rectangles
 * and hit-testing clicks against them would mean hand-rolling focus, hover, and disabled
 * states that the browser already gets right — including for anyone driving by keyboard.
 *
 * Placement is decided by `panelPosition` in `stats.js`, which is pure and tested. What is
 * left here is writing text into elements and moving one transform.
 */

import { panelPosition } from './stats.js';

/**
 * Wire up the unit panel.
 *
 * @param {Document} doc
 * @returns {{
 *   elements: { upgradeButton: HTMLButtonElement, sellButton: HTMLButtonElement },
 *   show: (content: PanelContent) => void,
 *   hide: () => void,
 * }}
 */
export function createUnitPanel(doc) {
  const el = (/** @type {string} */ id) => {
    const found = doc.getElementById(id);
    if (found === null) throw new Error(`missing element: ${id}`);
    return found;
  };

  const stage = el('stage');
  const canvas = /** @type {HTMLCanvasElement} */ (el('board'));
  const panel = el('unit-panel');
  const title = el('unit-panel-title');
  const stats = el('unit-panel-stats');
  const actions = el('unit-panel-actions');
  const upgradeButton = /** @type {HTMLButtonElement} */ (el('upgrade'));
  const sellButton = /** @type {HTMLButtonElement} */ (el('sell'));

  /**
   * What the panel last drew. Rebuilding the DOM every animation frame would mean
   * measuring it every frame too, and reading `offsetWidth` forces the browser to lay the
   * page out. Only content and position changes do any work; a still panel does none.
   *
   * @type {string | null}
   */
  let lastKey = null;

  /** @type {{ width: number, height: number }} */
  let size = { width: 0, height: 0 };

  return {
    elements: { upgradeButton, sellButton },

    /**
     * @typedef {object} PanelContent
     * @property {{ x: number, y: number }} tile Tile the panel points at.
     * @property {string} title
     * @property {Array<{ label: string, value: string }>} lines
     * @property {number} tilePxBacking Backing pixels per tile.
     * @property {{ upgrade: string, upgradeEnabled: boolean, sell: string,
     *   sellEnabled: boolean } | null} actions Null for a preview of a penguin that is
     *   not placed yet — there is nothing to upgrade or sell.
     */

    /**
     * Show the panel beside a tile.
     *
     * @param {PanelContent} content
     * @returns {void}
     */
    show(content) {
      const canvasRect = canvas.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();

      // The canvas size is in the key because the panel is positioned in CSS pixels: a
      // resized window moves the board under a panel that would otherwise never notice.
      const key = [
        content.tile.x,
        content.tile.y,
        content.title,
        content.lines.map((l) => `${l.label}=${l.value}`).join(','),
        content.actions === null
          ? 'preview'
          : `${content.actions.upgrade}/${content.actions.upgradeEnabled}` +
            `/${content.actions.sell}/${content.actions.sellEnabled}`,
        Math.round(canvasRect.width),
        Math.round(canvasRect.height),
      ].join('|');

      if (key !== lastKey) {
        lastKey = key;

        title.textContent = content.title;

        stats.replaceChildren();
        for (const { label, value } of content.lines) {
          const dt = doc.createElement('dt');
          dt.textContent = label;
          const dd = doc.createElement('dd');
          dd.textContent = value;
          stats.append(dt, dd);
        }

        actions.hidden = content.actions === null;
        if (content.actions !== null) {
          upgradeButton.textContent = content.actions.upgrade;
          upgradeButton.disabled = !content.actions.upgradeEnabled;
          sellButton.textContent = content.actions.sell;
          sellButton.disabled = !content.actions.sellEnabled;
        }

        // A preview follows the cursor across tiles the player is about to click on, so it
        // must not eat those clicks. The placed-penguin panel must catch them, or its own
        // buttons would not work.
        panel.classList.toggle('preview', content.actions === null);

        panel.hidden = false;
        size = { width: panel.offsetWidth, height: panel.offsetHeight };
      }

      panel.hidden = false;

      const { x, y } = panelPosition({
        tile: content.tile,
        panel: size,
        canvasRect,
        stageRect,
        backingWidth: canvas.width,
        tilePxBacking: content.tilePxBacking,
      });
      panel.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    },

    /** @returns {void} */
    hide() {
      panel.hidden = true;
      lastKey = null;
    },
  };
}
