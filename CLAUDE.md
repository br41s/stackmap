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
- `server.mjs` — static files, `/api/stack`, `/api/chat` (SSE), `/api/signal` (in) and
  `/api/signals` (SSE out). No framework, no build.
- `lib/signals.mjs` — agent signals: the folder → node table (`FOLDERS`), text cleaning and
  the in-memory buffer. `scripts/signal-hook.mjs` — the Claude Code Stop/Notification hook
  that posts them (800 ms timeout, always exits 0).
- `public/graph-model.js` — pure tree/edge-lifting logic, shared by the browser and tests.
- `public/narrate.js` — relations → briefing sentences; `public/orbit.js` — where neighbours
  go in focus mode. Both pure and tested (`test/cinematic.test.mjs`).
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
- Signals stay in memory, out of `data/` and out of the chat prompt (the cached index must not
  change per question). A renamed project id must be updated in `FOLDERS` — `npm test` fails.
