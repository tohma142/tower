# CLAUDE.md

Operating contract for this repository. It applies to every session, and it
overrides your defaults. When a rule here conflicts with a general habit you
have, this file wins; when two rules here conflict, the more specific one wins.

Rules are stated as behavior, not aspiration. If you can't follow one, say so
in your response — don't silently route around it.

---

## Project facts

> **Fill this block in for your repo. Everything below assumes it is accurate.**

- **What this is:** _one sentence — the thing this repo produces and who consumes it._
- **Runtime:** Node.js `>=20` (see `engines` in `package.json` — that field is the source of truth)
- **Module system:** ESM (`"type": "module"`). Use `import`/`export`; never `require` in source.
- **Package manager:** npm, `package-lock.json` committed. Never switch package managers casually.
- **Types:** JSDoc-annotated JavaScript, checked with `tsc --noEmit` via `checkJs`.
- **Entry points:** `src/index.js`
- **Layout:**
  - `src/` — application/library source
  - `test/` — tests, mirroring `src/` paths
  - `scripts/` — repo tooling, not shipped
  - `.github/workflows/` — CI

## Commands

Use these; don't invent equivalents or run tools directly when a script exists.

```sh
npm ci             # install exactly what the lockfile says (always in CI, and after a branch switch)
npm test           # full test suite
npm test -- <pat>  # single file or pattern — prefer this while iterating
npm run lint       # eslint
npm run lint:fix   # eslint --fix
npm run typecheck  # tsc --noEmit
npm run build      # if the repo ships a build
npm run check      # lint + typecheck + test — run this before you open a PR
```

`npm run check` must pass locally before you push. "CI will catch it" is not a
plan; it's a slower version of running it yourself.

---

## Working agreement

### Plan before non-trivial changes

Default to laying out an approach and getting agreement before writing code.
"Non-trivial" is broad: anything beyond a one-line fix, a typo, a comment, or a
mechanical config tweak. New behavior, a multi-file edit, a new module, a schema
or public-API touch, a refactor — all plan first.

This is a strong default, not an absolute bar. You may go straight to
implementation if you state up front — *in the turn before editing* — why the
change is trivial enough to skip planning, and nobody objects. Silence is not
consent to skip; the rebuttal has to be voiced and given a beat to land.

### Fetch ground truth before you build on it

Stale assumptions cause the most expensive rework. Probe current state before
you mutate it or design against it:

- Before branching or opening a PR: `git fetch`, check `git log origin/main..HEAD`
  for divergence, and `gh pr list --head <branch>` for a PR that already exists.
- Before changing a function's behavior, read its call sites — not just its body.
- Before concluding an async system "didn't fire," wait and re-check. CI, webhooks,
  and queue consumers lag.
- A bad experience with one *instance* isn't evidence against an approach. Measure
  the specific case in front of you before vetoing it.

### Trust state you've already confirmed

The inverse failure — burning turns re-checking what you know:

- No `git status`/`git pull` immediately after your own push or merge.
- Trust a green `gh pr checks` (or a `--watch` that exited 0). Only re-poll on
  non-zero or `UNKNOWN`.
- Don't re-read a file you just wrote to "verify" it — the write already errored
  if it failed.
- A confirmed diagnosis explains its downstream symptoms. Don't re-probe to
  confirm what you established.

### Measure the delta, don't assume it

A change is not an improvement until the improvement is measured. Capture the
load-bearing number *before* the change and again *after*, and let the delta
decide whether it stays. This applies to performance work, bundle size, flake
rates, and query counts alike. Never assert "this is faster" from the shape of
the diff.

### Fix the real problem, not the symptom

- **Never dismiss a test failure as "flaky."** Treat every failure as real signal.
  A retry that makes it pass is a workaround, not a fix — and it masks the defect
  for everyone after you. If you must add a retry to unblock, open an issue in the
  same action.
- **Broken build machinery or dev environment gets fixed first**, before you
  hand-roll a one-off workaround around it.
- **A fix scoped to one call site is a smell.** When a fix targets a single caller,
  ask whether the real fix is one layer up — otherwise you re-patch every sibling
  in turn.
- **Disconfirm a diagnosis before you propagate it.** A root cause is a hypothesis
  until a cheap check fails to falsify it. Before you file it as an issue, bake it
  into a comment, or fan a fix across sites, run the cheapest disconfirming probe
  the theory makes available — grep the file it names, check the package is
  actually installed, read the config it assumes. The more expensive the
  propagation, the more a ten-second falsification is worth first.

### A change isn't complete until it's reflected everywhere

- A new script, command, or module wires its own discoverability in the same
  change — the README, the index, the `--help`, the `package.json` scripts block.
  Never "add it now, make it findable later."
- When you reverse a direction, purge the superseded premise from every live
  artifact — the issue body, the open PR description, the doc comment — not just
  the place you recorded the reversal. A stale premise left standing is how a
  rejected direction quietly comes back.
- Renaming or deleting an export means updating every importer in the same commit.
  `npm run typecheck` is the check, not your memory.

---

## Git, branches, and pull requests

`main` is protected. **Never push to it directly**, never force-push a shared
branch, never merge without a green CI run.

1. **Branch** `<type>/<slug>` — type ∈ `feat|fix|chore|refactor|docs|test|perf`;
   slug kebab-case, ≤40 chars, descriptive. Branch off an up-to-date `origin/main`.
2. **Commit** in logical units. Imperative subject ≤72 chars, no trailing period,
   body explains *why* when the diff doesn't. Never put `Closes #N` in a commit
   message — it auto-closes on merge from the wrong place (see below).
3. **Push** `git push -u origin <branch>`.
4. **Open a PR** with `gh pr create`. The body carries the verification surface
   and the issue linkage (both below).
5. **Wait for CI green** before requesting review or merging.
6. **Merge** via the repo's configured strategy. Delete the branch after.

### Commit and PR hygiene

- Never commit generated artifacts, `node_modules`, `.env` files, or secrets.
- Never commit commented-out code "just in case" — git remembers.
- Keep a PR to one coherent change. If you fixed something incidental along the
  way, say so explicitly in the body rather than burying it.
- Don't rewrite history on a branch someone else has pulled.

### Issue linkage

When a PR resolves a tracked issue, the PR **body** must carry a closing keyword
as **bare text on its own line**:

```
Closes #123
```

Never wrap it in backticks or a code span — GitHub silently ignores closing
keywords inside inline code, so a backticked `` `Closes #123` `` merges the PR
and leaves the issue open. One PR can close several issues only when each gets
its own bare line (`Closes #1` then `Closes #2` — never `Closes #1 and #2`,
which closes only the first). A cross-repo close requires the fully-qualified
form: `Closes owner/repo#123`.

Omit linkage entirely for refactors, chores, or work with no pre-existing issue.
Don't invent issue references.

After merge, confirm the issue actually closed. If it didn't, the linkage was
missed — fix it by hand and treat it as a signal that the PR body template needs
attention.

### PR verification surface

Every PR ships a way for the reviewer to confirm correctness **without running
anything themselves**. A PR that says "run it and see" is incomplete. By change
type:

- **Behavior change** — show the observable before/after: the command output, the
  request/response, the test that now passes. "Tests pass" alone is not a surface;
  quote what the relevant test asserts.
- **Bug fix** — state the failure mode in one line, then show the regression test
  that fails without the fix.
- **Config / dependency change** — show the old and new values side by side and
  say what the runtime now does differently. Don't make the reviewer diff two
  JSON blobs to find the one line that matters.
- **Refactor with no behavior change** — make the "no behavior change" claim
  explicit and show what proves it (unchanged test suite passing, a typecheck
  run, identical output on a representative input).
- **Docs** — quote the new wording inline and name what it replaces or resolves.

Use this skeleton:

```markdown
## What
<one paragraph — what changed and why>

## Verification
<before/after evidence per the rules above>

## Risk / rollback
<what could break, and how to undo it>

Closes #N
```

### Working-tree ownership

A session mutates only the working tree it was launched in. A git checkout has
exactly one `HEAD` — reaching into another checkout to branch, commit, or merge
moves that pointer underneath whoever is working there.

For parallel or cross-branch work, use an isolated worktree:

```sh
git worktree add ../<repo>.wt/<slug> -b <type>/<slug>
```

and work under that path. A linked worktree is disposable scratch with its own
`HEAD` — writing one steps on nobody. Remove it when the PR merges.

If a shared checkout has uncommitted changes **you didn't make**, surface them —
never `git checkout -- .` or `git stash` your way past them. That destroys work
with no recovery.

---

## JavaScript & Node conventions

### Modules

- ESM only in source. Use the `node:` prefix for builtins: `import fs from 'node:fs/promises'`.
- Prefer named exports. A default export is for a module with exactly one obvious
  subject.
- No deep imports into another package's internals (`pkg/dist/internal/x`) — use
  its public entry points, or the dependency is wrong.
- Import order: builtins, external packages, internal modules, relative — with a
  blank line between groups. Let ESLint enforce it; don't hand-sort.
- No circular imports. If two modules need each other, a third module owns the
  shared piece.
- Side effects at import time are banned outside the entry point. Importing a
  module must not open a connection, read a file, or start a timer.

### Async and concurrency

- `async`/`await` everywhere. No `.then()` chains in new code, no callback style
  unless an API forces it (then wrap it with `node:util.promisify`).
- **No floating promises.** Every promise is awaited, returned, or explicitly
  handled with `.catch()`. An un-awaited async call in a sync function is a bug
  even when it appears to work.
- Independent async work runs concurrently:
  ```js
  const [user, prefs] = await Promise.all([fetchUser(id), fetchPrefs(id)]);
  ```
  Sequential `await`s in a loop over independent items is a defect, not a style
  choice. Use `Promise.all` — or a bounded-concurrency helper when the fan-out is
  large enough to matter (unbounded `Promise.all` over 10k items will exhaust
  sockets or memory).
- Use `Promise.allSettled` when partial failure is acceptable, and *act* on the
  rejected entries — don't drop them on the floor.
- Every outbound network call gets a timeout and an `AbortSignal`:
  ```js
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  ```
- Never block the event loop. No sync `fs` calls in a request path, no CPU-bound
  loops over large arrays in a handler — stream it, chunk it, or move it to a
  worker thread.
- Don't fire-and-forget background work in a serverless or short-lived process; it
  will be killed mid-flight.

### Errors

- Throw `Error` instances (or subclasses), never strings or plain objects.
- Preserve the chain: `throw new Error('failed to load config', { cause: err })`.
- Define narrow error classes for conditions callers need to branch on. Callers
  branch on the class, never on a substring of `err.message`.
- **Never swallow.** An empty `catch {}`, or a `catch` whose only body is a
  `console.log`, is a defect. Handle it, wrap and rethrow it, or don't catch it.
- Catch narrowly — around the operation that can fail, not around a whole function
  body.
- Validate at the boundary and fail loudly there; trust the data inward.
- `process.on('unhandledRejection')` is a last-resort logger and crash handler,
  not error handling.

### Values, types, and safety

- `===` always. `==` only for the deliberate `x == null` null-and-undefined check.
- `??` and `?.` over `||` and manual guards — `||` swallows `0`, `''`, and `false`,
  which is the classic config-default bug.
- Prefer immutability: `const` by default, non-mutating array methods (`map`,
  `filter`, `toSorted`, spread) over in-place mutation. Never mutate a function's
  arguments.
- No mutable module-level state unless it is an intentional, documented singleton
  (a connection pool, a cache) with a clear lifecycle.
- Functions take an options object once they exceed two parameters. Booleans in a
  call site (`doThing(x, true)`) are unreadable — name them.
- Validate external input (HTTP bodies, env, file contents, third-party responses)
  with a schema at the boundary. Don't hand-roll `typeof` ladders for structured
  payloads.
- JSDoc every exported function with param and return types. `npm run typecheck`
  is a required gate, so the annotations aren't decorative.

### Configuration and secrets

- All configuration comes from the environment, read and validated **once at
  startup** into a frozen config object. Modules import that object; they never
  read `process.env` themselves.
- Missing or malformed required config crashes at boot with a message naming the
  variable — never a silent default that surfaces as a 500 an hour later.
- Secrets never appear in source, tests, fixtures, logs, or error messages.
  `.env` is gitignored; `.env.example` documents the shape with dummy values.
- Never log a full request body, token, cookie, or connection string. Redact by
  default and allow-list what gets logged.

### Logging and observability

- Structured logging via the repo's logger. No bare `console.log` in `src/` —
  it's untaggable, unlevellable, and unfilterable.
- Log at boundaries (request in/out, job start/finish, external call) — not on
  every line of business logic.
- Include correlating context (request id, job id, user id) and never PII.
- An error log includes the error object, so the stack survives.

### Dependencies

- Prefer the standard library. Node ships `fetch`, `node:test`, `AbortSignal`,
  `structuredClone`, `crypto.randomUUID` — reach for a package only when the
  builtin genuinely doesn't cover it.
- A new runtime dependency is a decision, not a detail: say why in the PR body,
  and check its maintenance, install size, and transitive footprint first. A
  dependency for a one-line utility is a liability.
- Lockfile changes are reviewed. Don't regenerate `package-lock.json` wholesale as
  a side effect of an unrelated change.
- Pin dev tooling. Let `npm audit` findings be triaged, not auto-ignored.

### Security

- Never `eval`, `new Function`, or `child_process.exec` with interpolated input.
  Use `execFile`/`spawn` with an argument array.
- Any path built from user input is resolved and checked against its intended root
  before use — path traversal is the most common Node file-handling bug.
- Parameterized queries only. Never build SQL by concatenation.
- Compare secrets with `crypto.timingSafeEqual`, not `===`.
- Don't disable TLS verification, ever, including "just for local."
- Cap request body size, and cap the size of anything you `JSON.parse` from an
  untrusted source.

### Performance and resources

- Stream large payloads (`node:stream/promises` `pipeline`) rather than buffering
  whole files or responses into memory.
- Everything you open, you close — file handles, DB clients, servers, timers,
  watchers — in a `finally` or via an explicit shutdown path.
- Handle `SIGTERM`/`SIGINT`: stop accepting work, drain in flight, close
  resources, exit. A process that dies mid-request loses data.
- Don't optimize without a measurement (see "Measure the delta"). Correct and
  clear first.

---

## Testing

- Every bug fix ships a test that fails without the fix. No exceptions.
- Test the contract — the observable behavior of the public surface — not private
  implementation details. A refactor that breaks no behavior should break no test.
- Deterministic tests only: inject clocks, seed randomness, no reliance on
  wall-clock sleeps or network access. `setTimeout`-based "waits" are a flake
  source; use fake timers or await the actual signal.
- Test files mirror source paths, so `src/lib/parse.js` → `test/lib/parse.test.js`.
- Name tests by behavior: `returns null when the header is absent`, not `test 3`.
- Mock at the boundary (the HTTP client, the DB driver), not three layers deep
  into your own code. If mocking is painful, the seam is in the wrong place.
- Cover the error paths, not just the happy path — that's where the bugs live.
- Never weaken or `skip` a test to make CI green. A skipped test needs an issue
  number in a comment next to it, or it doesn't get skipped.

---

## Quality gates

CI runs a single required job. It must be green before merge, and its steps are:

```sh
npm ci
npm run lint
npm run typecheck
npm test
```

Rules about the gates themselves:

- Don't add per-rule ESLint disables to make a check pass. If a rule is wrong for
  this repo, change the config in its own PR with the reasoning; if it's right,
  fix the code. An inline disable needs a comment saying why.
- Don't lower coverage thresholds to land a change.
- A gate that's broken gets fixed, not bypassed. `--no-verify` is not a tool you
  reach for.

---

## Tracking work

### Capture at source

A thread that opens mid-work is never a bare aside:

- Part of what you're already doing → fold it into the current change or its PR
  description.
- Separate → **file a GitHub issue immediately**, then continue.

Route by kind: a **defect** (something broken, a gap, a regression, work that
should already exist) gets an issue. A speculative **enhancement** doesn't become
an issue just to look tracked — note it in the relevant PR or doc.

### Capture, don't ask

When you notice a defect you are *not* fixing now, don't end your turn with
"want me to file this?" That offer dies when the session ends, which is how bugs
get dropped. File it and mention that you did. Filing is reversible; a silently
dropped bug is not.

The sharpest trigger is **working around** something: the moment you reach for a
retry, a shim, a `skip`, or a manual step to route past something broken, file it
in that same action. That is exactly when it's easiest to promise yourself you'll
remember, and exactly when you won't.

### Issues that are worth reading

An issue states the observed behavior, the expected behavior, and how to
reproduce. For anything larger than a single change, state the **contract** —
what it produces, what it depends on, and how you'll know it's done — and leave
the implementation open. A body that prescribes implementation goes stale the
moment you learn something.

---

## How to communicate

- **Lead with the outcome.** State what happened first, then the detail. Don't
  narrate the journey before the conclusion.
- **Report faithfully.** If tests fail, say so and show the output. If you skipped
  a step, say which. If it's done and verified, say so plainly without hedging.
- **Reference issues and PRs with a title hook on first mention** — `#412 (retry
  loop drops errors)` — bare `#412` is fine after that. Qualify cross-repo refs as
  `owner/repo#N`.
- **Print URLs in full** at least once. A truncated link isn't clickable.
- **Render dates and times in local time** for anything a human reads. Store and
  parse in UTC.
- **Explain in plain terms before shorthand.** Decide low-stakes bookkeeping
  yourself rather than surfacing it as a question.
- **Put load-bearing context inside the question itself.** If a decision depends on
  something, it goes in the question or the final message — not in narration
  earlier in the turn that may not be read.
- **Ask only when the answer changes what you do.** Different readings leading to
  materially different work is a question. Everything else is a judgment call you
  make and note.

---

## Delegation and cost

- Delegate high-volume, context-polluting work — a broad grep sweep, a log trawl,
  a many-file read — to a subagent, and keep only the findings. Don't fill the
  main context with raw output.
- Route each piece of work to the cheapest model tier that fits its judgment
  level. Mechanical, high-volume stages don't need the strongest model; an
  architectural fork or a merge decision does. Set the tier deliberately rather
  than defaulting everything to the strongest.
- Read a tool's or script's usage before invoking it with guessed flags. A guessed
  flag costs a round-trip when it errors — and can silently succeed against the
  wrong target when it doesn't.
- Check platform dialect before leaning on a flag: macOS ships BSD tools (no GNU
  `timeout`, different `sed` regex rules). An expression that silently no-ops and
  happens to agree with your hypothesis is the expensive kind of wrong.

---

## Autonomy and consent

- **A timeout is not consent.** If you asked a question and got no answer, you may
  proceed only when the action has a genuinely safe default — and you say which
  default you took. For anything irreversible or outward-facing (a merge, a
  publish, a deploy, a push to a shared branch, anything that writes to an external
  system), an absent answer means it doesn't happen.
- **A grant is scoped to what earned it.** "Go ahead and merge the rest of these"
  covers that batch, at that quality bar. It doesn't carry into the next session,
  and any later explicit pause overrides it.
- **Do the requested scope.** Don't quietly narrow it, widen it, or transform it.
  If part of it turns out to be blocked, finish everything else and say explicitly
  what you left out and why — scaling the work down is not your call.
- **Confirm before destructive or outward-facing actions** unless you were already
  told to proceed. Approval in one context doesn't extend to the next. Before
  deleting or overwriting, look at what's there.
