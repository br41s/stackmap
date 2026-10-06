# stackmap — project instructions

Interactive map of Brais's stack + a chat backed by the local `claude` CLI. Localhost only.
Read `README.md` for the run commands and the data format.

## Layout

- `data/*.json` — the map. **Source of truth.** One file per slice; `core.json` holds layers,
  `brais` and shared `ext-*` services. Keep ids stable: the chat and links refer to them.
- `lib/stack.mjs` — merge + validation. `lib/prompt.mjs` — chat system prompt (compact map).
  `lib/chat.mjs` — spawns `claude -p` locked down; change its flags only with a re-test.
- `server.mjs` — static files, `/api/stack`, `/api/chat` (SSE). No framework, no build.
- `public/graph-model.js` — pure tree/edge-lifting logic, shared by the browser and tests.
- `public/app.js` (map), `public/chat.js` (floating chat), `public/style.css`.

## Rules

- Updating the map = editing `data/*.json`, then `npm run check` (0 errors) and `npm test`.
  Facts need a `sources` entry; guesses get `"confidence": "inferred"`.
- Never put secrets, IPs, emails, chat/thread ids or env var values in `data/`. Env var
  names are fine.
- The chat must stay read-only: no Bash/Edit/Write/WebFetch tools, no MCP servers. Deny
  patterns need the `//` absolute prefix (a bare `**/.env` misses `--add-dir` folders).
- Server stays bound to 127.0.0.1 with the Host and Origin checks; `npm test` covers them.
