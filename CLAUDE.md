# stackmap — project instructions

Interactive map of Brais's stack + a chat backed by the local `claude` CLI. Localhost only.
Read `README.md` for the run commands and the data format.

## Layout

- `data/*.json` — the map. **Source of truth.** One file per slice; `core.json` holds layers,
  `brais` and shared `ext-*` services. Keep ids stable: the chat and links refer to them.
- `lib/stack.mjs` — merge + validation. `lib/prompt.mjs` — what the chat sends: the cached
  index (system prompt, identical for every question — keep anything per-question out of it,
  or the cache breaks) and the per-question details (user prompt, picked by `relevantIds`).
  `lib/chat.mjs` — spawns `claude -p` locked down, map only (no tools) or Deep (Read/Grep/
  Glob); change its flags only with a re-test.
- `server.mjs` — static files, `/api/stack`, `/api/chat` (SSE), `/api/signal` (in),
  `/api/signals` (SSE out, no details) and `/api/activity?node=` (a node's history with
  details, plus a bot's `estado.md`). No framework, no build.
- `lib/signals.mjs` — agent signals: the folder → node table (`FOLDERS`), text/detail
  cleaning and the 14-day history. `lib/activity.mjs` — saves it to `.activity/activity.jsonl`
  (gitignored) and reloads it trimmed at start, trusting nothing in the file (same cleaning as a
  live signal; unknown kinds/nodes dropped). `scripts/signal-hook.mjs` — the Claude Code Stop/Notification hook
  that posts them (800 ms timeout, always exits 0). `lib/sources.mjs` — the other sources:
  the Fizz `estado.md` watcher (new lines → pings, `FIZZ_FOLDERS`) and the opt-in Hermes
  `/api/status` poller (changes → pings).
- `public/graph-model.js` — pure tree/edge-lifting logic, shared by the browser and tests.
- `public/narrate.js` — relations → briefing sentences; `public/orbit.js` — where neighbours
  go in focus mode. Both pure and tested (`test/cinematic.test.mjs`).
- `public/office-layout.js` — the 3D office as pure data: desks (`OFFICE_AGENTS`, ids match
  `AGENTS` in `lib/signals.mjs`), stations (children of `layer-products` / `layer-hosting`),
  node → object lookup, and `officeStates()` (where each agent is, from signals + time; hold
  times in `HOLD_MS`). `public/office.js` — draws it with three.js (procedural shapes, DOM
  labels and bubbles); app.js loads it on the first open, calls `show()` / `hide()` (hide stops
  the frame loop completely) and feeds it the same SSE signals. Tested in `test/office.test.mjs`;
  the renderer is not (needs a GPU) — check it by eye after changing it.
- `public/focus.js` — focus mode: snapshots the overview, flies nodes and camera, flowing
  light. Fades/resizes go through style classes + Cytoscape `transition-*` (app.js); only
  motion is animated, one `node.animation()` per flight — never `node.stop()`, which would
  also freeze a class transition mid-fade.
- `lib/openrouter.mjs` — map-only answers via OpenRouter (gpt-oss-120b, no-retention
  providers, low reasoning); same events as `lib/chat.mjs`. Key from `.env`, never logged.
- `refresh/` — weekly refresh: `slices.json` (what feeds each slice), `brief.md` (the
  re-mapping agent's instructions), `state.json` (last refresh). `scripts/refresh-plan.mjs`
  (what changed — names, dates, commit subjects only), `scripts/data-diff.mjs` (PR summary,
  logic in `lib/data-diff.mjs`). Refresh PRs come from `.worktrees/refresh-<date>`.
- `public/app.js` (map, HUD, intro), `public/chat.js` (floating chat), `public/style.css`
  (dark only — the map is meant to be watched in the dark).

## Rules

- Updating the map = editing `data/*.json`, then `npm run check` (0 errors) and `npm test`.
  Facts need a `sources` entry; guesses get `"confidence": "inferred"`.
- Never put secrets, IPs, emails, chat/thread ids or env var values in `data/`. Env var
  names are fine.
- The chat must stay read-only: no Bash/Edit/Write/WebFetch tools, no MCP servers. Deny
  patterns need the `//` absolute prefix (a bare `**/.env` misses `--add-dir` folders).
- Token budget: `npm test` fails if the cached prompt nears the old full-map size. Measured
  2026-10-07: map only ~20–25k in / 0.6–1.7k out per question; Deep ~65k with one lookup.
- Server stays bound to 127.0.0.1 with the Host and Origin checks; `npm test` covers them.
  Signal POSTs are the inverse: no Origin allowed (local scripts only).
- three is pinned (0.187.0) and served as `three.module.js` + `three.core.js` (the module
  imports the core by relative path; this version has no `.min.js`). `office.js` imports it by
  absolute path — an import map would be inline script, which the CSP forbids.
- Signals carry an `agent` (known ids only, else inferred from the node). Live office state
  stays in the browser: never in `data/`, never in the chat prompt.
- Signals stay in `.activity/` (gitignored, 14 days), out of `data/` and out of the chat prompt
  (the cached index must not change per question). The SSE feed stays brief (no details); the
  Activity card fetches them. A renamed project id must be updated in `FOLDERS` / `FIZZ_FOLDERS` —
  `npm test` fails. The Hermes poller is the server's only outbound request: public probe only,
  opt-in by env var, never an authenticated endpoint.
