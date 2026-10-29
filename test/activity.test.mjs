import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadActivity, saveTo } from "../lib/activity.mjs";

const DAY = 86_400_000;

test("loading keeps the window, skips bad lines and rewrites the file trimmed", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "stackmap-activity-")), "sub", "activity.jsonl");
  const now = Date.now();
  assert.deepEqual(loadActivity(file, 14, { now }), []); // creates the folder, no file yet
  const fresh = { id: "a", node: "fizz", kind: "info", text: "fresh", at: now - DAY };
  const old = { id: "b", node: "fizz", kind: "info", text: "old", at: now - 30 * DAY };
  await writeFile(file, `${JSON.stringify(old)}\n{cut\n${JSON.stringify({ id: 1 })}\n${JSON.stringify(fresh)}\n`);
  assert.deepEqual(loadActivity(file, 14, { now }), [fresh]);
  assert.equal(await readFile(file, "utf8"), `${JSON.stringify(fresh)}\n`);
});

test("each new signal is appended as one line", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "stackmap-activity-")), "activity.jsonl");
  const save = saveTo(file);
  await save({ id: "1", node: "x", kind: "done", text: "one", at: 1 });
  await save({ id: "2", node: "x", kind: "done", text: "two", detail: "two\nlines", at: 2 });
  const lines = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((s) => s.id), ["1", "2"]);
  assert.equal(lines[1].detail, "two\nlines");
});

test("loading trusts nothing: unknown kinds and nodes dropped, text cleaned like a live signal", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "stackmap-activity-")), "activity.jsonl");
  const now = Date.now();
  const at = now - DAY;
  const rows = [
    { id: "ok", node: "fizz", kind: "done", text: "**Shipped** `x`\nsecond line", detail: "**Shipped** `x`\nsecond line", at },
    { id: "kind", node: "fizz", kind: "evil\" onclick", text: "x", at },
    { id: "node", node: "not-on-map", kind: "info", text: "x", at },
    { id: "empty", node: "fizz", kind: "info", text: "   ", at },
    { id: "same", node: "fizz", kind: "info", text: "same", detail: "same", at },
  ];
  await writeFile(file, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
  const kept = loadActivity(file, 14, { now, nodes: new Set(["fizz"]) });
  assert.deepEqual(kept.map((s) => s.id), ["ok", "same"]);
  assert.equal(kept[0].text, "Shipped x second line");
  assert.equal(kept[0].detail, "Shipped x\nsecond line");
  assert.equal(kept[1].detail, undefined);
  assert.equal((await readFile(file, "utf8")).trim().split("\n").length, 2); // the file is rewritten clean
});
