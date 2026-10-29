import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { FOLDERS, cleanDetail, cleanText, createSignals, nodeForCwd } from "../lib/signals.mjs";
import { loadStack } from "../lib/stack.mjs";

const where = { workspace: "/w", home: "/h" };

test("a folder maps to its node; the longest match wins", () => {
  assert.equal(nodeForCwd("/w/biglobster", where), "proj-biglobster");
  assert.equal(nodeForCwd("/w/biglobster/.worktrees/fix-x/web", where), "proj-biglobster");
  assert.equal(nodeForCwd("/w/grow-shop/grow-shop-api/src", where), "proj-grow-shop-api");
  assert.equal(nodeForCwd("/w/grow-shop", where), "proj-grow-shop");
  assert.equal(nodeForCwd("/h/fizz/agents", where), "fizz");
});

test("unknown folders fall back; a name prefix is not a match", () => {
  assert.equal(nodeForCwd("/w/biglobster-videos", where), "vscode-workspace");
  assert.equal(nodeForCwd("/w", where), "vscode-workspace");
  assert.equal(nodeForCwd("/tmp/x", where), "claude-code");
  assert.equal(nodeForCwd("relative/path", where), null);
  assert.equal(nodeForCwd(undefined, where), null);
});

test("every node the folders point at is on the map", () => {
  const ids = new Set(loadStack(fileURLToPath(new URL("../data", import.meta.url))).nodes.map((n) => n.id));
  for (const id of [...Object.values(FOLDERS), "vscode-workspace", "claude-code"]) assert.ok(ids.has(id), `${id} missing from data/`);
});

test("text becomes one short line", () => {
  assert.equal(cleanText("  fixed\n\tthe  build \u0007 "), "fixed the build");
  assert.equal(cleanText("x".repeat(500)).length, 140);
  assert.equal(cleanText(42), "");
});

test("markdown becomes plain text; snake_case and [[mentions]] survive", () => {
  assert.equal(cleanText("**Zero tokens a day.** No part calls a model"), "Zero tokens a day. No part calls a model");
  assert.equal(cleanText("Committed as `2183717 feat(signals): x` on `feat/agent-signals`"), "Committed as 2183717 feat(signals): x on feat/agent-signals");
  assert.equal(cleanText("Opened [br41s/stackmap#5 — feat](https://github.com/br41s/stackmap/pull/5)"), "Opened br41s/stackmap#5 — feat");
  assert.equal(cleanText("## Done\n- fixed *the* build\n> quoted __note__"), "Done fixed the build quoted note");
  assert.equal(cleanText("renamed signal_hook in [[proj-finview]], 2 * 3 = 6"), "renamed signal_hook in [[proj-finview]], 2 * 3 = 6");
});

test("the buffer keeps the newest, fans out, and forgets unsubscribed listeners", () => {
  const signals = createSignals({ keep: 2 });
  const got = [];
  const off = signals.subscribe((s) => got.push(s.text));
  signals.add({ node: "a", kind: "done", text: "1" });
  signals.add({ node: "a", kind: "nonsense", text: "2" });
  off();
  signals.add({ node: "a", kind: "waiting", text: "3" });
  assert.deepEqual(got, ["1", "2"]);
  assert.deepEqual(signals.recent().map((s) => [s.text, s.kind]), [["2", "info"], ["3", "waiting"]]);
  assert.notEqual(signals.recent()[0].id, signals.recent()[1].id);
});

test("a detail keeps its line breaks, as plain text, capped", () => {
  assert.equal(cleanDetail("**Done.**\r\n\n\n\n- fixed `x`\n  - and [y](https://z)\t!"), "Done.\n\nfixed x\nand y !");
  assert.equal(cleanDetail("x".repeat(5000)).length, 2000);
  assert.equal(cleanDetail(null), "");
});

test("history: per node with details, brief for the ticker, older than the window dropped", () => {
  const saved = [];
  const old = { id: "old", node: "a", kind: "info", text: "ancient", at: Date.now() - 20 * 86_400_000 };
  const signals = createSignals({ keep: 2, days: 14, history: [old], onAdd: (s) => saved.push(s.text) });
  const live = [];
  signals.subscribe((s) => live.push(s));
  signals.add({ node: "a", kind: "done", text: "one", detail: "one\nmore" });
  signals.add({ node: "b", kind: "done", text: "two", detail: "two" });
  signals.add({ node: "a", kind: "waiting", text: "three" });
  assert.deepEqual(saved, ["one", "two", "three"]);
  assert.deepEqual(signals.forNodes(["a"]).map((s) => [s.text, s.detail]), [["three", undefined], ["one", "one\nmore"]]);
  assert.ok(signals.recent().every((s) => !("detail" in s)) && live.every((s) => !("detail" in s)));
  assert.equal(signals.forNodes(["b"])[0].detail, undefined); // same as its text: not stored twice
});
