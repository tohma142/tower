import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLoop } from '../../src/server/loop.js';
import { silentLogger } from '../helpers/server.js';

/**
 * A loop driven by a clock the test controls, so nothing waits on real time.
 *
 * @param {number} [tickMs]
 */
function controlledLoop(tickMs = 50) {
  let clock = 0;
  /** @type {Array<{ nowMs: number, dtMs: number }>} */
  const ticks = [];
  const logger = silentLogger();

  const loop = createLoop({
    tickMs,
    logger,
    now: () => clock,
    onTick: (nowMs, dtMs) => ticks.push({ nowMs, dtMs }),
  });

  return {
    loop,
    ticks,
    logger,
    /** @param {number} ms */
    advance(ms) {
      clock += ms;
      return loop.step();
    },
  };
}

describe('fixed timestep', () => {
  it('always reports the fixed step, never the real elapsed time', () => {
    // If dt tracked real elapsed time, tower cooldowns and enemy speeds would depend on
    // how busy the machine was.
    const { ticks, advance } = controlledLoop(50);

    advance(137);

    assert.ok(ticks.length > 0);
    for (const tick of ticks) assert.equal(tick.dtMs, 50);
  });

  it('runs one step per whole interval elapsed', () => {
    const { advance } = controlledLoop(50);

    assert.equal(advance(50), 1);
    assert.equal(advance(100), 2);
    assert.equal(advance(49), 0, 'a partial interval runs nothing');
  });

  it('carries the remainder forward instead of discarding it', () => {
    // Discarding it would make the simulation run slightly slow, forever, in a way
    // nobody would notice until wave timings drifted.
    const { advance } = controlledLoop(50);

    assert.equal(advance(30), 0);
    assert.equal(advance(30), 1, '60ms accumulated crosses one step');
    assert.equal(advance(40), 1, 'the leftover 10ms plus 40 crosses again');
  });

  it('catches up when the timer fires late', () => {
    const { advance } = controlledLoop(50);

    assert.equal(advance(200), 4, 'a late timer still owes four steps');
  });

  it('refuses to replay hours after the process was suspended', () => {
    // Honest elapsed time here would spin through hours of waves in one blocking loop.
    const { advance, logger } = controlledLoop(50);

    const steps = advance(6 * 60 * 60 * 1000);

    assert.ok(steps <= 20, `expected the catch-up to be capped, ran ${steps} steps`);
    assert.ok(
      logger.lines.some((l) => JSON.parse(l).msg === 'clock jumped, dropping elapsed time'),
      'a dropped span should be logged, not silent',
    );
  });

  it('does not run backwards if the clock does', () => {
    const { loop, advance } = controlledLoop(50);
    advance(100);

    // System clock adjustments can move time backwards.
    let ran = 0;
    assert.doesNotThrow(() => {
      ran = loop.step();
    });
    assert.equal(ran, 0);
  });
});

describe('start and stop', () => {
  it('reports whether it is running', () => {
    const { loop } = controlledLoop();

    assert.equal(loop.running, false);
    loop.start();
    assert.equal(loop.running, true);
    loop.stop();
    assert.equal(loop.running, false);
  });

  it('is safe to start twice', () => {
    const { loop } = controlledLoop();
    loop.start();
    assert.doesNotThrow(() => loop.start());
    loop.stop();
  });

  it('is safe to stop when never started', () => {
    const { loop } = controlledLoop();
    assert.doesNotThrow(() => loop.stop());
  });

  it('leaves no timer behind after stopping', () => {
    // A surviving interval keeps the process alive through a clean shutdown.
    const { loop, ticks } = controlledLoop();
    loop.start();
    loop.stop();
    const after = ticks.length;

    assert.equal(loop.running, false);
    assert.equal(ticks.length, after);
  });
});
