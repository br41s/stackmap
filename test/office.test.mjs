// The office's pure logic (public/office-layout.js) and the agent field it depends on
// (lib/signals.mjs). The renderer itself (public/office.js) needs a GPU and is not tested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { AGENTS, AGENT_HOME, agentForNode, cleanAgent, createSignals } from "../lib/signals.mjs";
import { loadStack } from "../lib/stack.mjs";
import { HOLD_MS, OFFICE_AGENTS, createLocator, holdMs, layoutOffice, officeStates, pushSignal, slotOffset, stepToward } from "../public/office-layout.js";

const stack = loadStack(fileURLToPath(new URL("../data", import.meta.url)));
const layout = layoutOffice(stack);
const locator = createLocator(stack, layout);
const NOW = 1_000_000;
const sig = (over) => ({ id: "s", node: "proj-finview", agent: "claude-code", kind: "working", text: "shipped", at: NOW - 1000, ...over });
const states = (signals, now = NOW) => officeStates({ layout, locator, signals, now });

// ---------- agent field ----------

test("an agent id is kept only if it is known", () => {
  for (const a of AGENTS) assert.equal(cleanAgent(a), a);
  assert.equal(cleanAgent("gpt-9"), null);
  assert.equal(cleanAgent('claude-code" onclick'), null);
  assert.equal(cleanAgent(undefined), null);
});

test("a signal without an agent gets one from its node, deterministically", () => {
  assert.equal(agentForNode("hermes"), "hermes");
  assert.equal(agentForNode("hermes-gateway"), "hermes");
  assert.equal(agentForNode("zb-hermes-eu-hermes"), "hermes");
  assert.equal(agentForNode("fizz-bot-seodesk"), "buzz");
  assert.equal(agentForNode("buzz-channel-tech"), "buzz");
  assert.equal(agentForNode("proj-finview"), "claude-code");
  assert.equal(agentForNode("vscode-workspace"), "claude-code");
});

test("createSignals: the agent given wins, a bad one is replaced, saved entries without one are filled in", () => {
  const old = { id: "old", node: "hermes-gateway", kind: "info", text: "saved before agents", at: Date.now() - 1000 };
  const signals = createSignals({ history: [old] });
  signals.add({ node: "proj-finview", agent: "gemini", kind: "done", text: "a" });
  signals.add({ node: "proj-finview", agent: "skynet", kind: "done", text: "b" });
  signals.add({ node: "fizz", kind: "done", text: "c" });
  assert.deepEqual(signals.recent().map((s) => s.agent), ["hermes", "gemini", "claude-code", "buzz"]);
  assert.ok(signals.forNodes(["proj-finview"]).every((s) => AGENTS.includes(s.agent)));
});

test("the office seats exactly the agents the server knows, and the desk opens the agent's home node", () => {
  assert.deepEqual(OFFICE_AGENTS.map((a) => a.id), AGENTS);
  for (const a of OFFICE_AGENTS) assert.equal(AGENT_HOME[a.id], a.nodes.find((id) => AGENT_HOME[a.id] === id), a.id); // no home = no desk node
});

test("the card of an agent's home lists what it sent anywhere, plus what is inside the node", () => {
  const signals = createSignals();
  signals.add({ node: "proj-finview", agent: "claude-code", kind: "done", text: "elsewhere" });
  signals.add({ node: "cc-hooks", agent: "claude-code", kind: "working", text: "inside" });
  signals.add({ node: "proj-finview", agent: "hermes", kind: "info", text: "not mine" });
  const texts = (list) => list.map((s) => s.text);
  assert.deepEqual(texts(signals.forNodes(["claude-code", "cc-hooks"], 300, "claude-code")), ["inside", "elsewhere"]);
  assert.deepEqual(texts(signals.forNodes(["claude-code", "cc-hooks"])), ["inside"]); // a plain node card is unchanged
});

// ---------- layout ----------

test("every project and platform on the map becomes a station; every agent gets a desk", () => {
  const kids = (parent, kind) => stack.nodes.filter((n) => n.parent === parent && n.kind === kind).map((n) => n.id);
  assert.deepEqual(layout.stations.filter((s) => s.zone === "project").map((s) => s.node), kids("layer-products", "project"));
  assert.deepEqual(layout.stations.filter((s) => s.zone === "infra").map((s) => s.node), kids("layer-hosting", "platform"));
  assert.deepEqual(layout.desks.map((d) => d.agent), AGENTS);
  assert.deepEqual(layout.desks.map((d) => d.node), ["claude-code", "hermes", "buzz", null, null]); // Gemini / ChatGPT: reserved
  assert.deepEqual(layout.desks.map((d) => d.reserved), [false, false, false, true, true]);
});

test("the layout is deterministic and nothing overlaps or leaves the floor", () => {
  assert.deepEqual(layoutOffice(stack), layout);
  const things = [...layout.desks, ...layout.stations];
  for (let i = 0; i < things.length; i++) {
    const a = things[i];
    assert.ok(a.x >= layout.bounds.minX && a.x <= layout.bounds.maxX && a.z >= layout.bounds.minZ && a.z <= layout.bounds.maxZ, `${a.node ?? a.agent} outside the floor`);
    for (const b of things.slice(i + 1)) assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= 2.5, `${a.node ?? a.agent} too close to ${b.node ?? b.agent}`);
  }
});

test("a desk lights up when the map has its node, and the layout follows a custom stack", () => {
  const small = { nodes: [
    { id: "layer-products", kind: "layer" }, { id: "p1", kind: "project", parent: "layer-products", label: "P1" },
    { id: "ext-gemini", kind: "external" },
  ] };
  const l = layoutOffice(small);
  assert.deepEqual(l.stations.map((s) => s.node), ["p1"]);
  assert.equal(l.desks.find((d) => d.agent === "gemini").node, "ext-gemini");
  assert.equal(l.desks.find((d) => d.agent === "chatgpt").reserved, true);
  assert.equal(layoutOffice({ nodes: [] }).stations.length, 0); // an empty map still has a floor
});

// ---------- which object a node belongs to ----------

test("a node resolves to its nearest station or desk, through the tree", () => {
  assert.equal(locator.resolve("proj-finview-api").key, "station:proj-finview");
  assert.equal(locator.resolve("zb-hermes-eu-hermes").key, "station:zeabur"); // Hermes' service lives on Zeabur
  assert.equal(locator.resolve("hermes-gateway").key, "desk:hermes");
  assert.equal(locator.resolve("fizz-bot-seodesk").key, "desk:buzz");
  assert.equal(locator.resolve("cc-hooks").key, "desk:claude-code");
  assert.equal(locator.resolve("brais"), null);
  assert.equal(locator.resolve("not-on-the-map"), null);
});

// ---------- who is where ----------

test("without signals everyone sits at their own desk, idle", () => {
  const s = states([]);
  for (const d of layout.desks) {
    assert.equal(s[d.agent].mode, "idle");
    assert.deepEqual(s[d.agent].target, d.stand);
    assert.equal(s[d.agent].text, "");
  }
});

test("a signal sends its agent to the station with the signal's text; the others stay put", () => {
  const s = states([sig({})]);
  const station = layout.stations.find((x) => x.node === "proj-finview");
  assert.equal(s["claude-code"].mode, "working");
  assert.deepEqual(s["claude-code"].target, station.stand);
  assert.equal(s["claude-code"].text, "shipped");
  assert.equal(s["claude-code"].signalId, "s");
  assert.equal(s.hermes.mode, "idle");
});

test("the task decides when the agent walks back: it stays while working, goes home after done", () => {
  const start = NOW - 10 * 60_000; // ten minutes into the task: no timer has sent it home
  assert.equal(states([sig({ id: "a", at: start })])["claude-code"].mode, "working");
  assert.equal(states([sig({ id: "a", at: start }), sig({ id: "b", kind: "waiting", at: NOW - 60_000 })])["claude-code"].mode, "waiting");
  // the Stop arrives: the result stays up for the linger, then the agent is home
  const finished = [sig({ id: "a", at: start }), sig({ id: "b", kind: "done", text: "all green", at: NOW })];
  const done = states(finished, NOW + HOLD_MS.done - 1)["claude-code"];
  assert.equal(done.mode, "done");
  assert.equal(done.text, "all green");
  assert.equal(states(finished, NOW + HOLD_MS.done)["claude-code"].mode, "idle");
});

test("a task that never reports back is given up on; a note is brief; hold times can be replaced", () => {
  const at = NOW - 1000;
  assert.equal(states([sig({ at })], at + HOLD_MS.working - 1)["claude-code"].mode, "working");
  assert.equal(states([sig({ at })], at + HOLD_MS.working)["claude-code"].mode, "idle");
  assert.equal(states([sig({ kind: "info", at })], at + HOLD_MS.info)["claude-code"].mode, "idle");
  assert.ok(HOLD_MS.working > HOLD_MS.done && HOLD_MS.waiting > HOLD_MS.done);
  assert.equal(holdMs({ kind: "nonsense" }), HOLD_MS.info);
  const quick = { ...HOLD_MS, working: 5_000 };
  assert.equal(officeStates({ layout, locator, signals: [sig({ at })], now: at + 5_000, hold: quick })["claude-code"].mode, "idle");
});

test("a request for the user is 'waiting'; a node with no station keeps the agent at its desk, working", () => {
  assert.equal(states([sig({ kind: "waiting", node: "proj-finview" })])["claude-code"].mode, "waiting");
  const own = states([sig({ agent: "hermes", node: "hermes-gateway" })]).hermes;
  assert.equal(own.mode, "working");
  assert.deepEqual(own.target, layout.desks.find((d) => d.agent === "hermes").stand);
  assert.deepEqual(states([sig({ node: "brais" })])["claude-code"].target, layout.desks[0].stand);
});

test("only the latest signal of an agent counts; signals from the future and from strangers are ignored", () => {
  const s = states([sig({ id: "a", node: "proj-finview", at: NOW - 5000 }), sig({ id: "b", node: "proj-chatmemo", at: NOW - 2000 })]);
  assert.equal(s["claude-code"].signalId, "b");
  assert.equal(states([sig({ at: NOW + 5000 })])["claude-code"].mode, "idle");
  assert.equal(states([sig({ agent: "skynet" })])["claude-code"].mode, "idle");
  assert.equal(Object.keys(states([sig({ agent: "skynet" })])).length, AGENTS.length);
});

test("two agents at one station collaborate and stand apart; a visitor at a desk does too", () => {
  const s = states([sig({ id: "a" }), sig({ id: "b", agent: "hermes", text: "same repo" })]);
  assert.equal(s["claude-code"].mode, "collaborating");
  assert.equal(s.hermes.mode, "collaborating");
  assert.notDeepEqual(s["claude-code"].target, s.hermes.target);
  assert.equal(s["claude-code"].target.z, s.hermes.target.z);

  const visit = states([sig({ node: "hermes-gateway" })]);
  assert.equal(visit["claude-code"].mode, "collaborating"); // Claude Code is at Hermes' desk
  assert.equal(visit.hermes.mode, "idle");
  assert.ok(Math.abs(visit["claude-code"].target.x - visit.hermes.target.x) >= 1);
});

test("the list of signals: one entry per id, oldest first, capped", () => {
  let list = [];
  list = pushSignal(list, sig({ id: "2", at: 2 }));
  list = pushSignal(list, sig({ id: "1", at: 1 }));
  list = pushSignal(list, sig({ id: "2", at: 2 }));
  assert.deepEqual(list.map((s) => s.id), ["1", "2"]);
  assert.deepEqual(pushSignal(list, sig({ id: "3", at: 3 }), 2).map((s) => s.id), ["2", "3"]);
  assert.equal(pushSignal(list, null), list);
});

test("walking: steps toward the target, never past it", () => {
  const a = stepToward({ x: 0, z: 0 }, { x: 3, z: 4 }, 2.5);
  assert.deepEqual(a.pos, { x: 1.5, z: 2 });
  assert.equal(a.arrived, false);
  const b = stepToward(a.pos, { x: 3, z: 4 }, 10);
  assert.deepEqual(b.pos, { x: 3, z: 4 });
  assert.equal(b.arrived, true);
  // seated already, or a zero / negative step (the first frame of the loop): never NaN
  for (const step of [0, -0.05, 3]) assert.deepEqual(stepToward({ x: 2, z: 2 }, { x: 2, z: 2 }, step).pos, { x: 2, z: 2 });
  assert.deepEqual(stepToward({ x: 0, z: 0 }, { x: 3, z: 4 }, -1).pos, { x: 0, z: 0 });
  assert.deepEqual([slotOffset(0, 1), slotOffset(0, 2), slotOffset(1, 2)], [0, -0.6, 0.6]);
});
