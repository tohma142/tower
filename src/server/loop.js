/**
 * The fixed-timestep driver.
 *
 * Every room advances in whole 50ms steps regardless of what the timer actually does.
 * `setInterval` is not accurate — it drifts under load, fires late, and on a laptop
 * that slept can fire once after a very long gap — so real elapsed time accumulates
 * here and is spent in fixed increments. Without that, tower cooldowns and enemy speeds
 * would quietly depend on how busy the machine was.
 */

/**
 * Largest span of real time a single wake-up is allowed to make up.
 *
 * When a process is suspended and resumes hours later, the honest elapsed time would
 * spin the simulation through hours of waves in one blocking loop. Capping it means the
 * game simply lost that time, which is the right answer for a game nobody was watching.
 */
const MAX_CATCHUP_MS = 1000;

/**
 * Create the loop.
 *
 * @param {object} options
 * @param {(nowMs: number, dtMs: number) => void} options.onTick
 * @param {number} options.tickMs Fixed timestep.
 * @param {() => number} [options.now] Clock, injected so tests need no timers.
 * @param {import('../logger.js').Logger} options.logger
 * @returns {{ start: () => void, stop: () => void, step: () => number, get running(): boolean }}
 */
export function createLoop({ onTick, tickMs, now = () => Date.now(), logger }) {
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let last = 0;
  let accumulator = 0;

  /**
   * Advance by however much real time has passed, in whole steps.
   *
   * Exposed so tests can drive the loop with a fake clock rather than waiting.
   *
   * @returns {number} Steps run.
   */
  function step() {
    const current = now();
    const elapsed = current - last;
    last = current;

    if (elapsed > MAX_CATCHUP_MS) {
      logger.warn('clock jumped, dropping elapsed time', { elapsedMs: elapsed });
      accumulator += MAX_CATCHUP_MS;
    } else if (elapsed > 0) {
      accumulator += elapsed;
    }

    let steps = 0;
    while (accumulator >= tickMs) {
      accumulator -= tickMs;
      onTick(current, tickMs);
      steps += 1;
    }
    return steps;
  }

  return {
    get running() {
      return timer !== null;
    },

    start() {
      if (timer !== null) return;
      last = now();
      accumulator = 0;
      timer = setInterval(step, tickMs);
    },

    stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },

    step,
  };
}
