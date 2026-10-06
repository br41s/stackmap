# stackmap

An interactive map of the whole stack — Zeabur, Hermes, Claude Code, Buzz/Fizz and every
product — with a floating chat that answers questions about it.

- **Map:** layers → systems → services, collapsible at every level. A collapsed group keeps
  its relations: edges are redrawn to the nearest visible ancestor, so collapsing Hermes
  turns *gateway → Zeabur service* into *Hermes → Zeabur*.
- **Chat:** the local `claude` CLI, using your Claude Code login (no API key). It answers
  from the map first and reads the real repo files (read-only) when it needs more.
- **Local only:** the server binds to `127.0.0.1`.

## Run

```bash
npm install
npm start          # http://127.0.0.1:4317
```

| Key / gesture | Does |
|---|---|
| click | select, show details, highlight relations |
| double-click | open / close a group |
| `/` | search |
| `Esc` | clear selection |
| Focus toggle | hide relations that don't touch the selection |
| `[[node-id]]` in a chat answer | click to jump to that node |

Env vars (all optional): `PORT` (4317), `STACKMAP_MODEL` (`sonnet`), `STACKMAP_EFFORT`
(`medium`), `STACKMAP_WORKSPACE` (parent folder of this repo), `STACKMAP_AS_OF`.

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

```bash
npm run check      # merge + list dangling edges, unknown parents, cycles, duplicates
npm test           # merge, edge lifting, prompt, server request guards
```

## Chat safety

Each question runs `claude -p` with: `--tools Read,Grep,Glob`, `--strict-mcp-config` (no MCP
servers, so it cannot post to Buzz or touch Zeabur), `--setting-sources ""` (no settings,
hooks or CLAUDE.md), `--permission-mode dontAsk`, `--no-session-persistence` (keeps these
chats out of `~/.claude/projects` and ChatMemo), and read denials for `.env*`, keys, `nsec`,
`*secret*`, `credentials*`. It can read the workspace, `~/fizz` and `~/.buzz`.

The server only answers requests whose `Host` is `127.0.0.1:<port>` / `localhost:<port>`
(DNS rebinding), and chat POSTs must carry this page's `Origin` and a JSON body (no
cross-site form posts).
