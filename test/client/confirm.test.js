/**
 * The two-step confirm behind the Restart button.
 *
 * The property that matters is that exactly one sequence fires the action — two clicks
 * close together — and that every other sequence does not. Restarting cannot be undone,
 * so a false positive here ends someone else's run.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createConfirm } from '../../src/client/render/confirm.js';

describe('createConfirm', () => {
  it('does not fire on the first click', () => {
    const confirm = createConfirm({ windowMs: 4000 });

    assert.equal(confirm.click(1000), 'armed');
  });

  it('fires on a second click inside the window', () => {
    const confirm = createConfirm({ windowMs: 4000 });

    confirm.click(1000);
    assert.equal(confirm.click(3000), 'confirmed');
  });

  it('re-arms rather than firing once the window has passed', () => {
    // The dangerous case: a click from a minute ago must not combine with one now into a
    // confirmation nobody meant to give.
    const confirm = createConfirm({ windowMs: 4000 });

    confirm.click(1000);
    assert.equal(confirm.click(60_000), 'armed');
  });

  it('treats the last moment of the window as inside it', () => {
    const confirm = createConfirm({ windowMs: 4000 });

    confirm.click(1000);
    assert.equal(confirm.click(5000), 'confirmed');
  });

  it('treats one millisecond past the window as outside it', () => {
    const confirm = createConfirm({ windowMs: 4000 });

    confirm.click(1000);
    assert.equal(confirm.click(5001), 'armed');
  });

  it('cannot be confirmed twice by a stray double-click', () => {
    // A double-click is two clicks a few milliseconds apart. The first pair confirms; the
    // third click must arm again rather than firing a second restart.
    const confirm = createConfirm({ windowMs: 4000 });

    assert.equal(confirm.click(1000), 'armed');
    assert.equal(confirm.click(1010), 'confirmed');
    assert.equal(confirm.click(1020), 'armed');
  });

  it('reports armed only while it is armed', () => {
    const confirm = createConfirm({ windowMs: 4000 });

    assert.equal(confirm.isArmed(1000), false, 'nothing clicked yet');

    confirm.click(1000);
    assert.equal(confirm.isArmed(1000), true);
    assert.equal(confirm.isArmed(5000), true, 'the last moment of the window');
    assert.equal(confirm.isArmed(5001), false, 'one past it');
  });

  it('stops reporting armed the moment it confirms', () => {
    // The label is drawn from `isArmed`, so a confirm that left it armed would leave
    // "Restart? Click again" on screen after the game had already restarted.
    const confirm = createConfirm({ windowMs: 4000 });

    confirm.click(1000);
    confirm.click(1500);

    assert.equal(confirm.isArmed(1500), false);
  });

  it('disarms on reset, so leaving the screen cancels a pending confirm', () => {
    const confirm = createConfirm({ windowMs: 4000 });

    confirm.click(1000);
    confirm.reset();

    assert.equal(confirm.isArmed(1000), false);
    assert.equal(confirm.click(1100), 'armed', 'reset must not leave it primed to fire');
  });

  it('defaults to a window long enough to read the question', () => {
    // No argument is the real call site. A window measured in milliseconds would be a
    // confirmation nobody could act on.
    const confirm = createConfirm();

    confirm.click(0);
    assert.equal(confirm.isArmed(1500), true, 'still armed a second and a half later');
  });
});
