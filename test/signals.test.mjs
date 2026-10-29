import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { FOLDERS, cleanText, createSignals, nodeForCwd } from "../lib/signals.mjs";
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
