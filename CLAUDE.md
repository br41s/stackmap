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
- `server.mjs` — static files, `/api/stack`, `/api/chat` (SSE). No framework, no build.
- `public/graph-model.js` — pure tree/edge-lifting logic, shared by the browser and tests.
- `public/narrate.js` — relations → briefing sentences; `public/orbit.js` — where neighbours
  go in focus mode. Both pure and tested (`test/cinematic.test.mjs`).
- `public/focus.js` — focus mode: snapshots the overview, flies nodes and camera, flowing
  light. Fades/resizes go through style classes + Cytoscape `transition-*` (app.js); only
  motion is animated, one `node.animation()` per flight — never `node.stop()`, which would
  also freeze a class transition mid-fade.
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
