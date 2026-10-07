import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSlices } from "../lib/stack.mjs";
import { buildIndex, representative, visibleNodeIds, liftEdges, descendantCount } from "../public/graph-model.js";
import { userPrompt, compactStack } from "../lib/prompt.mjs";

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
  assert.match(compactStack(tree), /gateway -deployed-on-> server: runs on/);
});
