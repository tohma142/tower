/**
 * Run the test suite under a wall-clock watchdog.
 *
 * Why this exists rather than just `node --test`: a test that hangs used to run forever.
 * The runner has no default timeout, so the process outlived the shell that started it and
 * sat at 100% CPU until someone noticed — in the case that prompted this, 25 hours later.
 *
 * `--test-timeout` alone does not fix it. That timeout is a timer inside the runner, and a
 * *synchronous* hang — `while (true) {}`, or a `while` loop whose condition never becomes
 * false — never yields the thread, so the timer cannot fire. That is precisely the shape of
 * the bug this guards against: a loop waiting for a state change that a broken helper never
 * makes. Verified, not assumed: with only `--test-timeout` set, a synchronous spin ran past
 * three minutes untouched.
 *
 * So both are used, because they catch different things:
 *   - `--test-timeout` catches an *async* hang and names the test that did it.
 *   - this watchdog catches a *synchronous* hang, which nothing inside the process can.
 *
 * The child is spawned in its own process group and killed by group, so no orphan survives
 * the runner exiting.
 */

import { spawn } from 'node:child_process';

/** Wall-clock budget for the whole suite. The suite runs in about 4 seconds; this is a
 *  runaway backstop, not a performance target. */
const BUDGET_MS = Number(process.env.TEST_BUDGET_MS ?? 120_000);

/** Per-test budget inside the runner. Catches async hangs and names the culprit. */
const PER_TEST_MS = 30_000;

const args = ['--test', `--test-timeout=${PER_TEST_MS}`, ...process.argv.slice(2)];

const child = spawn(process.execPath, args, {
  stdio: 'inherit',
  // Its own process group, so the kill below takes the runner *and* the per-file workers
  // it spawned. Killing only the runner is what leaves the 100%-CPU orphan behind.
  detached: true,
});

let timedOut = false;

const watchdog = setTimeout(() => {
  timedOut = true;
  process.stderr.write(
    `\ntest run exceeded ${BUDGET_MS}ms and was killed.\n` +
      'A test is hanging. A synchronous loop cannot be interrupted from inside the\n' +
      'runner, so nothing above will name it — run the suites individually to find it.\n',
  );

  try {
    // Negative pid = the whole group. SIGKILL because a spinning process will not
    // service SIGTERM either.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Already gone between the timer firing and this call; nothing to clean up.
  }
}, BUDGET_MS);

child.on('exit', (code, signal) => {
  clearTimeout(watchdog);

  if (timedOut) {
    process.exit(1);
  }

  // A signal death is still a failure, and exiting 0 here would let CI go green on one.
  process.exit(code ?? (signal === null ? 1 : 1));
});

child.on('error', (error) => {
  clearTimeout(watchdog);
  process.stderr.write(`failed to start the test runner: ${error.message}\n`);
  process.exit(1);
});
