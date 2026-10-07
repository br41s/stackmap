import { test } from "node:test";
import assert from "node:assert/strict";
import { narrate, listOf } from "../public/narrate.js";
import { orbitPositions, orbitRadius, MIN_GAP, MIN_RADIUS } from "../public/orbit.js";

test("lists read like English", () => {
  assert.equal(listOf(["A"]), "A");
  assert.equal(listOf(["A", "B"]), "A and B");
  assert.equal(listOf(["A", "B", "C"]), "A, B and C");
  assert.equal(listOf(["A", "B", "C", "D", "E"]), "A, B, C and 2 more");
});

test("the briefing says what a node uses, then who uses it, most relations first", () => {
  const story = narrate("Hermes", [
    { dir: "out", kind: "deployed-on", other: "Zeabur" },
    { dir: "out", kind: "uses-model", other: "OpenRouter" },
    { dir: "out", kind: "uses-model", other: "Hugging Face" },
    { dir: "out", kind: "notifies", other: "Telegram" },
    { dir: "out", kind: "notifies", other: "Telegram" }, // duplicates collapse
    { dir: "in", kind: "manages", other: "Claude Code" },
    { dir: "in", kind: "controls", other: "Brais" },
    { dir: "in", kind: "controls", other: "Claude Code" },
  ]);
  assert.equal(story[0], "Hermes thinks with OpenRouter and Hugging Face, runs on Zeabur and reports to Telegram.");
  assert.equal(story[1], "Brais and Claude Code control it.");
  assert.equal(story[2], "Claude Code manages it.");
});

test("a node with no relations says so, and the briefing stays short", () => {
  assert.deepEqual(narrate("Lonely", []), ["Lonely has no relations on the map yet."]);
  const many = Array.from({ length: 12 }, (_, i) => ({ dir: "in", kind: ["calls", "reads", "writes", "monitors", "serves", "deploys"][i % 6], other: `N${i}` }));
  assert.ok(narrate("Busy", many).length <= 4);
});

test("orbit: uses go right, used-by go left, both-ways counted once", () => {
  const c = { x: 100, y: 50 };
  const pos = orbitPositions(c, ["a", "b", "both"], ["x", "both"]);
  assert.equal(pos.size, 4);
  for (const id of ["a", "b", "both"]) assert.ok(pos.get(id).x > c.x, `${id} should be right`);
  assert.ok(pos.get("x").x < c.x, "x should be left");
});

test("orbit: neighbours never sit closer than MIN_GAP on a ring, however many", () => {
  for (const n of [1, 2, 5, 9, 14]) {
    const ids = Array.from({ length: n }, (_, i) => `n${i}`);
    const pos = [...orbitPositions({ x: 0, y: 0 }, ids, []).values()];
    for (let i = 1; i < pos.length; i++) {
      const d = Math.hypot(pos[i].x - pos[i - 1].x, pos[i].y - pos[i - 1].y);
      assert.ok(d >= MIN_GAP * 0.9, `n=${n}: gap ${d.toFixed(1)}`);
    }
  }
  assert.equal(orbitRadius(1, 0), MIN_RADIUS);
  // Crowded sides split over two rings instead of shrinking the gap.
  const crowd = [...orbitPositions({ x: 0, y: 0 }, Array.from({ length: 24 }, (_, i) => `c${i}`), []).values()];
  const radii = new Set(crowd.map((p) => Math.round(Math.hypot(p.x, p.y))));
  assert.equal(radii.size, 2);
});
