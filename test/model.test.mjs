import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSlices } from "../lib/stack.mjs";
import { buildIndex, representative, visibleNodeIds, liftEdges, descendantCount } from "../public/graph-model.js";
import { userPrompt, mapIndex, relevantIds, contextFor, systemPrompt } from "../lib/prompt.mjs";
import { loadStack } from "../lib/stack.mjs";

const n = (id, parent = null, kind = "service") => ({ id, label: id.toUpperCase(), kind, parent });

// layer ─┬─ hermes ─┬─ gateway
//        │          └─ cron
//        └─ zeabur ── server
const tree = {
  nodes: [n("layer", null, "layer"), n("hermes", "layer"), n("gateway", "hermes"), n("cron", "hermes"), n("zeabur", "layer"), n("server", "zeabur"), n("telegram")],
  edges: [
    { source: "gateway", target: "server", kind: "deployed-on", label: "runs on" },
    { source: "cron", target: "server", kind: "deployed-on", label: "runs on" },
    { source: "cron", target: "gateway", kind: "calls", label: "posts through" },
    { source: "gateway", target: "telegram", kind: "notifies", label: "sends" },
  ],
};

test("merge unions lists of a node defined twice and keeps the first parent", () => {
  const { nodes, issues } = mergeSlices([
    { file: "a.json", data: { nodes: [{ ...n("x", "p"), details: ["one"] }, n("p"), n("q")] } },
    { file: "b.json", data: { nodes: [{ ...n("x", "q"), details: ["one", "two"], summary: "late" }] } },
  ]);
  const x = nodes.find((v) => v.id === "x");
  assert.deepEqual(x.details, ["one", "two"]);
  assert.equal(x.parent, "p");
  assert.equal(x.summary, "late");
  assert.deepEqual(x.files, ["a.json", "b.json"]);
  assert.equal(issues.filter((i) => i.level === "warn").length, 1);
});

test("merge drops dangling and self-loop edges, dedupes repeats", () => {
  const { edges, issues } = mergeSlices([
    { file: "a.json", data: { nodes: [n("a"), n("b")], edges: [
      { source: "a", target: "b", kind: "calls" },
      { source: "a", target: "b", kind: "calls" },
      { source: "a", target: "ghost", kind: "calls" },
      { source: "a", target: "a", kind: "calls" },
    ] } },
  ]);
  assert.equal(edges.length, 1);
  assert.ok(issues.some((i) => i.level === "error" && i.message.includes("ghost")));
  assert.ok(issues.some((i) => i.message.includes("self-loop")));
});

test("merge breaks parent cycles and orphaned parents", () => {
  const { nodes, issues } = mergeSlices([{ file: "a.json", data: { nodes: [n("a", "b"), n("b", "a"), n("c", "missing")] } }]);
  assert.equal(nodes.find((v) => v.id === "c").parent, null);
  assert.ok(nodes.some((v) => v.parent === null && (v.id === "a" || v.id === "b")));
  assert.equal(issues.filter((i) => i.level === "error").length, 2);
});

test("collapsed groups stand in for their descendants", () => {
  const index = buildIndex(tree);
  const overview = new Set(["layer"]);
  assert.equal(representative(index, "gateway", overview), "hermes");
  assert.deepEqual(visibleNodeIds(index, overview).sort(), ["hermes", "layer", "telegram", "zeabur"]);
  assert.equal(descendantCount(index, "layer"), 5);
  // Nothing expanded: the layer itself represents everything inside it.
  assert.equal(representative(index, "server", new Set()), "layer");
});

test("edges are lifted to visible ancestors; internal edges disappear", () => {
  const index = buildIndex(tree);
  const lifted = liftEdges(index, new Set(["layer"]));
  const pairs = lifted.map((e) => `${e.source}>${e.target}`);
  assert.ok(pairs.includes("hermes>zeabur"));
  assert.ok(pairs.includes("hermes>telegram"));
  assert.ok(!pairs.includes("hermes>hermes"), "cron→gateway is internal to Hermes");
  // Every original cross-group edge is still accounted for after merging.
  const covered = lifted.flatMap((e) => e.edges).length;
  assert.equal(covered, 3);
  for (const e of lifted) assert.ok(e.source && e.target && e.kind && Array.isArray(e.edges));
});

test("parallel lifted edges merge into one line per direction", () => {
  const index = buildIndex({
    nodes: tree.nodes,
    edges: [
      ...tree.edges,
      { source: "gateway", target: "server", kind: "calls", label: "health check" },
      { source: "server", target: "cron", kind: "calls", label: "wakes" },
    ],
  });
  const lifted = liftEdges(index, new Set(["layer"]));
  const out = lifted.find((e) => e.source === "hermes" && e.target === "zeabur");
  assert.equal(out.edges.length, 3, "two deployed-on + one calls");
  assert.equal(out.kind, "deployed-on", "most common kind wins");
  assert.equal(out.label, "deployed-on · calls");
  assert.ok(lifted.some((e) => e.source === "zeabur" && e.target === "hermes"), "reverse direction stays its own line");
  assert.equal(lifted.filter((e) => e.source === "hermes" && e.target === "zeabur").length, 1);
  // A single edge keeps its own label.
  assert.equal(lifted.find((e) => e.target === "telegram").label, "sends");
});

test("expanding shows the real endpoints again", () => {
  const index = buildIndex(tree);
  const lifted = liftEdges(index, new Set(["layer", "hermes", "zeabur"]));
  assert.equal(lifted.flatMap((e) => e.edges).length, 4);
  assert.ok(lifted.some((e) => e.source === "cron" && e.target === "gateway"));
});

test("chat prompt carries history, focus and the question", () => {
  const p = userPrompt([
    { role: "user", content: "what is hermes?" },
    { role: "assistant", content: "an agent" },
    { role: "user", content: "where does it run?" },
  ], "hermes");
  assert.match(p, /Brais: what is hermes\?/);
  assert.match(p, /You: an agent/);
  assert.match(p, /\[\[hermes\]\] selected/);
  assert.match(p, /Question: where does it run\?$/);
  assert.doesNotMatch(p, /DETAILS/, "no details block when none are passed");
  assert.match(userPrompt([{ role: "user", content: "q" }], null, "[x] X"), /DETAILS for this question:\n\[x\] X/);
});

test("the index names every node and groups relations by source, with no prose", () => {
  const idx = mapIndex(tree);
  assert.match(idx, /^ {2}gateway\|GATEWAY\|service$/m, "a grandchild of the layer, indented twice");
  assert.match(idx, /^layer\|LAYER\|layer$/m);
  assert.match(idx, /^gateway: deployed-on server; notifies telegram$/m);
  assert.match(idx, /^cron: deployed-on server; calls gateway$/m);
  assert.doesNotMatch(idx, /runs on|posts through/, "relation labels stay out of the cached index");
});

test("a question pulls in the selection, [[mentions]] and named nodes — not common words", () => {
  const stack = {
    nodes: [n("zeabur-frankfurt"), n("hermes", null, "platform"), n("hermes-gateway", "hermes"), n("finview"), n("x-server")],
    edges: [],
  };
  stack.nodes[0].label = "Tencent Frankfurt server";
  stack.nodes[1].label = "Hermes";
  stack.nodes[2].label = "Gateway (multiplex)";
  stack.nodes[3].label = "FinView";
  stack.nodes[4].label = "Some server";
  assert.deepEqual(relevantIds(stack, { text: "what breaks if the Frankfurt server goes down?" }), ["zeabur-frankfurt"]);
  assert.deepEqual(relevantIds(stack, { text: "explain this", focus: "finview" }), ["finview"]);
  assert.deepEqual(relevantIds(stack, { text: "compare [[hermes-gateway]] and Hermes" }), ["hermes-gateway", "hermes"]);
  assert.deepEqual(relevantIds(stack, { text: "which server is it on?" }), [], "'server' alone names nothing");
});

test("details carry relation notes and neighbour one-liners, and stay under the cap", () => {
  const stack = { ...tree, nodes: tree.nodes.map((x) => ({ ...x, summary: `${x.id} does things` })) };
  stack.edges = [...tree.edges, { source: "gateway", target: "telegram", kind: "notifies", label: "sends", note: "topic per tenant" }];
  const d = contextFor(stack, ["gateway"]);
  assert.match(d, /^\[gateway\] GATEWAY — service/m);
  assert.match(d, /gateway -notifies-> telegram: sends \(topic per tenant\)/);
  assert.match(d, /NEIGHBOURS[\s\S]*\[server\] SERVER \(service\): server does things/);
  assert.ok(contextFor(stack, ["gateway"], { maxChars: 60 }).length < 120);
});

test("the cached prompt for the real map stays a fraction of the full data", () => {
  const stack = loadStack(new URL("../data", import.meta.url).pathname);
  const sys = systemPrompt(stack, { workspace: "/w", readDirs: ["/w"], asOf: "x" });
  // The whole map with details was ~262k chars; the index must stay well under that.
  assert.ok(sys.length < 60_000, `system prompt ${sys.length} chars`);
  for (const n of stack.nodes) assert.match(sys, new RegExp(`\\n *${n.id.replace(/[.]/g, "\\.")}\\|`), `index misses ${n.id}`);
});

test("map-only chat has no tools at all; deep mode gets the read-only tools and deny rules", async () => {
  const { cliArgs } = await import("../lib/chat.mjs");
  const map = cliArgs({ model: "m", effort: "low", readDirs: ["/w"], system: "S" });
  assert.deepEqual(map.slice(map.indexOf("--tools"), map.indexOf("--tools") + 2), ["--tools", ""]);
  assert.ok(!map.includes("--add-dir") && !map.includes("--disallowedTools"));
  const deep = cliArgs({ model: "m", effort: "low", readDirs: ["/w"], system: "S", deep: true });
  assert.ok(deep.includes("Read,Grep,Glob") && deep.includes("--add-dir") && deep.includes("Read(//**/.env)"));
  // Both still lock the CLI down.
  for (const args of [map, deep]) {
    for (const flag of ["--strict-mcp-config", "--no-session-persistence"]) assert.ok(args.includes(flag), flag);
    assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  }
  const sys = (d) => systemPrompt({ nodes: [], edges: [] }, { workspace: "/w", readDirs: ["/w"], asOf: "x", deep: d });
  assert.match(sys(false), /MAP-ONLY MODE/);
  assert.match(sys(true), /DEEP MODE/);
});


test("the refresh diff names what was added, removed, retired and rewired", async () => {
  const { diffStacks, diffMarkdown } = await import("../lib/data-diff.mjs");
  const before = { nodes: [n("a"), n("b"), { ...n("c"), status: "live" }], edges: [{ source: "a", target: "b", kind: "calls" }] };
  const after = {
    nodes: [n("a"), { ...n("c"), status: "retired" }, n("d")],
    edges: [{ source: "a", target: "d", kind: "calls" }],
  };
  const d = diffStacks(before, after);
  assert.deepEqual([d.added, d.removed, d.changed], [["d"], ["b"], ["c"]]);
  assert.deepEqual(d.statusChanged, [{ id: "c", from: "live", to: "retired" }]);
  assert.deepEqual([d.edgesAdded, d.edgesRemoved], [["a -calls-> d"], ["a -calls-> b"]]);
  const md = diffMarkdown(d);
  assert.match(md, /\*\*Status changed \(1\)\*\*\n- `c` live → retired/);
  assert.doesNotMatch(md, /Facts updated/, "a status-only change is not listed twice");
  assert.equal(diffMarkdown(diffStacks(before, before)), "No changes to the map.");
});
