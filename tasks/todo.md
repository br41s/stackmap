# stackmap — first slice

Goal: one local page that shows the whole stack (Zeabur, Hermes, Claude Code, Buzz, products)
as a zoomable, collapsible graph, plus a floating chat that answers questions about it.

Decisions (2026-10-06, Brais): chat runs on the local `claude` CLI (no API key); app is
localhost only (127.0.0.1).

## Plan

- [x] Map the stack read-only: Hermes, Zeabur + hosting, Claude Code, Buzz/Fizz, products
- [x] `data/*.json` — one file per slice + `core.json` (layers, person, external services)
- [x] `lib/stack.mjs` — merge slices, report dangling edges / duplicate ids / parent cycles
- [x] `public/graph-model.js` — pure functions: visible nodes for an expanded set, edges
      lifted to the nearest visible ancestor
- [x] `public/app.js` — Cytoscape + fcose map: expand/collapse, search, details panel,
      neighbourhood focus, legend
- [x] `public/chat.js` — floating chat, SSE streaming, `[[node-id]]` links jump to the map
- [x] `server.mjs` — static files + `/api/chat`; spawns `claude -p` with Read/Grep/Glob only,
      no MCP servers, no settings/CLAUDE.md, no session persistence; Host/Origin checks
- [x] `npm run check` + `node --test` for merge/validation and edge lifting

## Verification

- [x] `npm run check` reports 0 dangling edges
- [x] `npm test` green
- [x] Browser: expand Hermes, collapse it again, search a node, open details
- [x] Chat: one answer from the map alone, one that needs a file read, `[[id]]` link focuses
- [x] Request from a foreign Origin / Host is refused (403)

## Done 2026-10-06

- 6 slices merged: 333 nodes, 551 relations, 0 errors, 0 warnings (duplicates across slices merged,
  29 containment-as-edge relations dropped; the validator now warns on those)
- QA in /browse: search → reveal → details; Expand button and double-click; chat answer in 17 s with
  `[[id]]` links that focus the map; phone width (no horizontal scroll)
- Chat lockdown tested live: `.env` read refused (absolute `//**/` pattern), Grep finds nothing

## Next

- [x] `mergeLiftedEdges`: one line per direction of a pair, most common kind, label lists all kinds (2026-10-07, delegated by Brais)
- [x] GitHub remote: https://github.com/br41s/stackmap (private), pushed 2026-10-07
- [ ] If the ~72k-token chat prompt bites on limits: send summaries + edges only, let it Read `data/`
- [ ] Map refresh: rerun the slice mappers, or a scanner, when the stack drifts

## Cinematic 2D — 2026-10-07

Brais: "plain and static… more like in a movie": each click zooms and magnifies the selection,
reorganises the relations, and summarises them. Chose cinematic 2D over a 3D galaxy.

- [x] Dark HUD look: star field with parallax, vignette, canvas glow, glass panels.
- [x] Intro: nodes fly out from the centre, groups and relations fade in, title card.
- [x] Focus mode (`focus.js`): hero grows and pulses; uses orbit right, used-by left
      (`orbit.js`); dashed light flows along relations; the rest recedes; travel with history;
      Esc restores every position and the viewport.
- [x] HUD briefing typed out (`narrate.js`), relation chips by kind, facts collapsed.
- [x] Fixes found in QA: group boxes dimmed their contents (compound opacity multiplies);
      `node.stop()` froze class transitions half-faded; chips/crumbs were `<a>` without href
      (not keyboard reachable) → buttons.
- [x] Tests: 5 new (narrate, orbit); 17/17. Browser QA: intro, focus, travel, back, fly-out,
      group framing, phone bottom sheet, no console errors.

## Chat token use — 2026-10-07

Before: every question carried the whole map (~72k tokens; $0.50 notional on a cold cache,
$0.06 warm). Measured after, same questions:

- [x] Cached index instead of the full map: every node (indented tree) and relation by name,
      ~19k tokens; per-question DETAILS for the selection / named nodes / inside / neighbours
      in the user prompt (1–5k), so the cache holds across questions.
- [x] Map-only mode by default (`--tools ""`: one call, CLI overhead 650 vs 4.6k tokens) and a
      Deep toggle for file reads; effort low for map only, medium for Deep.
- [x] Token footer on every answer; server log line with in/cached/out and mode.
- Frankfurt question: 72k → 19.9k in. Hermes cron question: 118.7k (3 lookups) → 25.1k map
  only; with Deep 65k and exact schedules.

## GPT-OSS for map-only, weekly refresh — 2026-10-07

Brais chose gpt-oss-120b over DeepSeek V4 Flash (reasoning can't be capped; trickling fallback
providers in Hermes) and over Haiku (still subscription), and a weekly refresh PR.

- [x] `lib/openrouter.mjs`: streamed, `data_collection: "deny"`, reasoning low, usage + real
      cost; map-only uses it when `OPENROUTER_API_KEY` is in `.env`, Claude otherwise. Tests
      with a fake stream (keep-alives, usage chunk, HTTP and mid-stream errors).
- [x] Chat header names the model per mode; billed cost shown on OpenRouter answers.
- [x] Refresh: `refresh/slices.json`, `refresh/brief.md`, `refresh/state.json` (seeded with the
      2026-10-06 mapping time), `scripts/refresh-plan.mjs` (first real run: all 5 slices
      changed — e.g. hermes #415–#417, chatmemo #71–#74, fizz #16–#19), `lib/data-diff.mjs`.
- [x] Scheduled task `stackmap-weekly-refresh`, Mondays 09:01, PR only, never merges.
- [ ] Brais: OPENROUTER_API_KEY in stackmap/.env, then a quality check vs Sonnet.
- [ ] Brais: one "Run now" of the refresh task to approve its tools.

