# stackmap

An interactive map of the whole stack — Zeabur, Hermes, Claude Code, Buzz/Fizz and every
product — with a floating chat that answers questions about it.

- **Map:** layers → systems → services, collapsible at every level. A collapsed group keeps
  its relations: edges are redrawn to the nearest visible ancestor, so collapsing Hermes
  turns *gateway → Zeabur service* into *Hermes → Zeabur*.
- **Cinematic focus:** the stack assembles itself on load. Click a node and the camera flies
  in: it grows and pulses, what it uses swings into orbit on the right, what uses it on the
  left, light runs along each relation in its direction, the rest of the map recedes, and the
  HUD types out a briefing ("Hermes runs on Zeabur, thinks with OpenRouter…"). Click a
  neighbour to travel; Esc flies back out with every node returning to its place.
- **Chat:** two modes, switched in the chat header:
  - **map only** (default): `openai/gpt-oss-120b` through OpenRouter when `OPENROUTER_API_KEY`
    is in `stackmap/.env` (only no-retention providers: `data_collection: "deny"`; ~$0.001 a
    question, billed on the key, shown on the answer); without a key, the local `claude` CLI
    on your Claude Code login. No tools, one model call. The cached prompt is an index of every
    node and relation by name (~19k tokens, a cache read after the first question of the
    hour); each question adds details only for the nodes it is about — the selection, what it
    names, what is inside it, its neighbours (~1–5k). ~20–25k tokens in, ~0.6–1.7k out.
  - **Deep**: always the local `claude` CLI (Sonnet), which may also read the real repo files
    (read-only). Each lookup re-sends the prompt, so expect ~3× the tokens; use it for exact
    schedules, config, live state.
  Every answer shows its mode, time and tokens (in / cached / out).
- **Local only:** the server binds to `127.0.0.1`.

## Run

```bash
npm install
npm start          # http://127.0.0.1:4317
```

| Key / gesture | Does |
|---|---|
| click a node | fly in: orbit + briefing |
| click a neighbour, or a chip in the HUD | travel there |
| click an open group | frame it, briefing for the whole group |
| double-click | open / close a group |
| `Backspace` | back to the previous focus |
| `Esc` / click empty space | fly back out |
| `/` | search (lands in focus on the result) |
| `[[node-id]]` in a chat answer | click to fly to that node |

Motion follows the OS "reduce motion" setting: with it on, every move is instant.

Env vars (all optional, `stackmap/.env` is read at start): `OPENROUTER_API_KEY`,
`STACKMAP_MAP_MODEL` (`openai/gpt-oss-120b`; `claude` forces the CLI), `PORT` (4317),
`STACKMAP_MODEL` (Claude model for Deep, `sonnet`), `STACKMAP_EFFORT`
(default `low` for map only, `medium` for Deep), `STACKMAP_WORKSPACE` (parent folder of this
repo), `STACKMAP_AS_OF`.

## Data

`data/*.json` is the source of truth — one file per slice, merged at request time:

| File | Covers |
|---|---|
| `core.json` | layers, Brais, shared external services |
| `hosting.json` | Zeabur (projects, services, Frankfurt server), Vercel, GCP, Neon, Cloudflare, GitHub, Plesk, domains |
| `hermes.json` | Hermes: gateway, profiles, agents, cron jobs, Telegram topics, deploy |
| `claude-code.json` | Claude Code config, agents, skills, hooks, MCP servers; the VSCODE workspace |
| `buzz.json` | Buzz relay and channels, the Fizz bot fleet in `~/fizz` |
| `products.json` | every product and its parts |

Node: `{ id, label, kind, parent, summary, details[], status, links[], sources[], confidence }`.
Edge: `{ source, target, kind, label, note?, sources[], confidence }`. `parent` is the
hierarchy; edges are everything else. Kinds are listed in `lib/stack.mjs`.

`confidence`: `verified` (checked live when compiled), `from-docs`, `inferred` (shown in
italics on the map). Compiled 2026-10-06 from the repos, decision logs and read-only live
checks (`zeabur`, `gh`, buzz `fleet_status`).

### Weekly refresh

The map does not watch the stack live. A scheduled Claude task on this Mac
(`~/.claude/scheduled-tasks/stackmap-weekly-refresh`, Mondays 09:00) keeps it current:

1. `scripts/refresh-plan.mjs` lists the slices whose sources changed since `refresh/state.json`
   — commits in their repos, modified decision logs and config folders, Zeabur projects and
   services added or removed (`refresh/slices.json` says what feeds each slice).
2. One subagent per changed slice updates only that `data/<slice>.json`, following
   `refresh/brief.md` (read-only everywhere else, ids kept stable, gone things retired).
3. `npm run check` + `npm test`, then a PR on `br41s/stackmap` with the map diff
   (`scripts/data-diff.mjs`). Nothing merges on its own; one refresh PR open at a time.

Run it by hand: Claude desktop → Scheduled → "Stackmap: weekly refresh PR" → Run now.

```bash
npm run check      # merge + list dangling edges, unknown parents, cycles, duplicates
npm test           # merge, edge lifting, prompt, server request guards
```

## Chat safety

Each question runs `claude -p` with: `--tools ""` (map only) or `--tools Read,Grep,Glob`
(Deep), `--strict-mcp-config` (no MCP servers, so it cannot post to Buzz or touch Zeabur), `--setting-sources ""` (no settings,
hooks or CLAUDE.md), `--permission-mode dontAsk`, `--no-session-persistence` (keeps these
chats out of `~/.claude/projects` and ChatMemo), and read denials for `.env*`, keys, `nsec`,
`*secret*`, `credentials*`. In Deep mode it can read the workspace, `~/fizz` and `~/.buzz`.

The server only answers requests whose `Host` is `127.0.0.1:<port>` / `localhost:<port>`
(DNS rebinding), and chat POSTs must carry this page's `Origin` and a JSON body (no
cross-site form posts).
