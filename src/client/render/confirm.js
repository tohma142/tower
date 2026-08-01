/**
 * Two-step confirmation for an action that cannot be undone.
 *
 * Restarting throws away everyone's run, so the button asks once before doing it. This is
 * the state behind that: the first click arms, a second click inside the window confirms,
 * and anything later re-arms rather than firing.
 *
 * No timer. Time is passed in, and the caller asks `isArmed(now)` on the frame it draws —
 * so the label reverts on its own without a `setTimeout` to cancel, and the whole thing is
 * testable without fake timers or a test that sleeps.
 */

/**
 * @param {object} [options]
 * @param {number} [options.windowMs] How long an armed action stays armed.
 * @returns {{
 *   click: (nowMs: number) => 'armed' | 'confirmed',
 *   isArmed: (nowMs: number) => boolean,
 *   reset: () => void,
 * }}
 */
export function createConfirm({ windowMs = 4000 } = {}) {
  /** @type {number | null} */
  let armedAt = null;

  /**
   * @param {number} nowMs
   * @returns {boolean}
   */
  function isArmed(nowMs) {
    return armedAt !== null && nowMs - armedAt <= windowMs;
  }

  return {
    isArmed,

    /**
     * @param {number} nowMs
     * @returns {'armed' | 'confirmed'}
     */
    click(nowMs) {
      if (isArmed(nowMs)) {
        // Disarm before reporting, so a double-click cannot confirm twice: the second
        // click of a stray double lands on a cleared state and merely re-arms.
        armedAt = null;
        return 'confirmed';
      }

      armedAt = nowMs;
      return 'armed';
    },

    /** @returns {void} */
    reset() {
      armedAt = null;
    },
  };
}
