# Tower

A co-operative browser tower defense game. Penguins with guns defend an iceberg from
wild animals walking a fixed path, across 15 waves. Up to four humans play the same
board together, buying penguins with a currency called **fish**.

No database, no accounts, no stored state. A room lives in memory for as long as
somebody is connected to it, and then it is gone.

## Status

Early scaffold. The quality gates, config, and logging are in place; the game itself is
not built yet. See the implementation order below for what lands next.

## Requirements

- Node.js `>=20` (the `engines` field in `package.json` is the source of truth)
- npm (the committed `package-lock.json` is authoritative — use `npm ci`, not `npm install`)

## Quick start

```sh
npm ci        # install exactly what the lockfile says
npm start     # serve the game on http://localhost:3000
```

Open the URL, and share the room link it gives you with another browser tab or another
machine on your LAN. Both players see the identical board.

To let other machines reach you, bind all interfaces:

```sh
HOST=0.0.0.0 npm start
```

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Run the server |
| `npm run dev` | Run with `--watch`, restarting on file changes |
| `npm test` | Full test suite (`node:test`) |
| `npm test -- <pattern>` | A single file or pattern — use this while iterating |
| `npm run test:coverage` | Test suite with a coverage report (advisory, never a gate) |
| `npm run lint` | ESLint |
| `npm run lint:fix` | ESLint with `--fix` |
| `npm run typecheck` | `tsc --noEmit` over JSDoc-annotated JS |
| `npm run check` | lint + typecheck + test — run before opening a PR |

`npm run check` must pass locally before you push.

> **Version note:** CI pins Node 20, the floor of the supported range, while local
> machines may be far ahead. If something works locally and fails in CI, suspect a
> post-20 API before suspecting CI. The reverse also bites: `node --test <dir>` searches
> a directory on Node 20 but resolves it as a module on Node 26, which is why the test
> script passes no path and relies on the runner's own discovery — that form works on
> both.

### Dependency overrides

`package.json` pins `brace-expansion` to `^5.0.8` via `overrides`. It arrives
transitively under `eslint-plugin-import` → `minimatch@3`, and versions at or below
`5.0.7` carry a DoS advisory ([GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg)).
`npm audit fix` wanted to solve this by downgrading `eslint-plugin-import` across a
major version; the override is the cheaper fix. Because it forces a major version under
a consumer that asked for `1.x`, removing it is fine but replacing it needs a check that
ESLint still *resolves files* — a broken glob layer makes lint pass by linting nothing.
Verify with `npx eslint . --format json` and confirm the file count is non-zero.

## Configuration

All configuration comes from the environment, read and validated once at startup into a
frozen object (`src/config.js`). No other module reads `process.env`. Copy
`.env.example` to `.env` for local overrides; it is gitignored.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP + WebSocket port |
| `HOST` | `127.0.0.1` | Bind interface; `0.0.0.0` exposes the game to your LAN |
| `LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, `error` |

A missing or malformed value crashes at boot with a message naming the variable.

## How it works

The server is authoritative. One Node process runs the game loop at a fixed 20 Hz,
holds every room in memory, and broadcasts a snapshot each tick. Clients send intents
("place a sniper on tile 7,3") and render what comes back; they never simulate. That is
what makes two players' views identical by construction rather than by careful
bookkeeping.

The client renders at ~60 Hz with a 100 ms render delay, interpolating between the two
snapshots that straddle `now - 100ms` — which is what makes a 20 Hz simulation look
smooth.

There is **no build step**. `src/shared/` and `src/client/` are plain ESM served
straight to the browser, and the server imports the same `src/shared/` files. One file
genuinely runs in both places.

### Layout

```
src/
  index.js      entry point — the only module with import-time side effects
  config.js     environment read once, validated, frozen
  logger.js     structured JSON-line logging
  server/       HTTP, WebSocket, rooms, tick loop
  game/         pure simulation — no I/O, fully unit tested
  shared/       constants, map, protocol — runs in Node and the browser
  client/       canvas renderer, HUD, input, network
test/           mirrors src/ paths
```

`src/game/` is pure by design: no I/O, an injected clock, and a seeded RNG. A full
15-wave game runs headlessly in a test in milliseconds, which is where most of the
correctness lives.

### Art

Monochrome pixel art — black, white, and three greys. Every sprite is a string array in
`src/client/render/sprites.js`, compiled once into an offscreen canvas at integer scale.
There are no image files in the repo, so sprites are diffable in git and a palette
change is one constant.

## Contributing

`main` is protected: no direct pushes, no force-pushes, and CI must be green to merge.

1. Branch off an up-to-date `origin/main` as `<type>/<slug>` where type is one of
   `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `perf`.
2. Commit in logical units with an imperative subject of 72 characters or less.
3. `npm run check` locally.
4. `gh pr create`, with a verification surface in the body so the reviewer can confirm
   correctness without running anything.

The full operating contract is in [CLAUDE.md](./CLAUDE.md).

## Testing

Tests are deterministic: the simulation takes an injected clock and a seeded RNG, so
nothing sleeps or depends on wall-clock timing. Test files mirror source paths, so
`src/game/towers.js` is tested by `test/game/towers.test.js`.

Coverage is reported in CI but is **advisory** — no threshold fails the build.

Deliberately not covered: canvas draw calls, DOM event wiring, real browser rendering,
and load behaviour. Everything decidable about rendering (interpolation, sprite
parsing, coordinate transforms) is extracted into pure modules and tested; what remains
untested is the blitting itself.
