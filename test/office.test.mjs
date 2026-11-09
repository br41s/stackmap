// The office's pure logic (public/office-layout.js) and the agent field it depends on
// (lib/signals.mjs). The renderer itself (public/office.js) needs a GPU and is not tested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { AGENTS, AGENT_HOME, agentForNode, cleanAgent, createSignals } from "../lib/signals.mjs";
import { loadStack } from "../lib/stack.mjs";
import { HOLD_MS, OFFICE_AGENTS, STYLE_RADIUS, agentOf, collectStations, createLocator, holdMs, layoutOffice, officeStates, pushSignal, routeBetween, slotOffset, stepToward, styleFor } from "../public/office-layout.js";
import { distToSegment, insideIsland, nearestOnPolyline, nearestRoad, shortestPath } from "../public/village.js";

const stack = loadStack(fileURLToPath(new URL("../data", import.meta.url)));
const layout = layoutOffice(stack);
const locator = createLocator(stack, layout);
const NOW = 1_000_000;
const sig = (over) => ({ id: "s", node: "proj-finview", agent: "claude-code", kind: "working", text: "shipped", at: NOW - 1000, ...over });
const xz = ({ x, z }) => ({ x, z });
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

test("every project, platform and what is inside them becomes a building; every agent gets a house", () => {
  const kids = (parent, kind) => stack.nodes.filter((n) => n.parent === parent && n.kind === kind).map((n) => n.id);
  const wanted = collectStations(stack);
  assert.deepEqual(layout.stations.map((s) => s.node).sort(), wanted.map((s) => s.node).sort());
  assert.deepEqual(layout.stations.filter((s) => s.zone === "project").map((s) => s.node).sort(), kids("layer-products", "project").sort());
  assert.deepEqual(layout.stations.filter((s) => s.zone === "platform").map((s) => s.node).sort(), kids("layer-hosting", "platform").sort());
  assert.ok(layout.stations.filter((s) => s.zone === "annex").length >= 30, "services, tools and jobs of the projects have their own buildings");
  const byNode = new Map(layout.stations.map((s) => [s.node, s]));
  for (const s of layout.stations.filter((x) => x.parentStation)) assert.ok(byNode.has(s.parentStation), `${s.node} stands beside a parent that is on the island`);
  assert.deepEqual(layout.desks.map((d) => d.agent), AGENTS);
  assert.deepEqual(layout.desks.map((d) => d.node), ["claude-code", "hermes", "buzz", null, null]); // Gemini / ChatGPT: reserved
  assert.deepEqual(layout.desks.map((d) => d.reserved), [false, false, false, true, true]);
});

test("a station carries its node's status, so retired services can be drawn as ruins", () => {
  const status = new Map(stack.nodes.map((n) => [n.id, n.status]));
  assert.ok(layout.stations.every((st) => st.status === status.get(st.node)));
  assert.ok(layout.stations.some((st) => st.status === "retired"));
});

test("the village is deterministic; every building is on dry land, apart from the others, within reach of a street", () => {
  assert.deepEqual(layoutOffice(stack), layout);
  const things = [...layout.desks, ...layout.stations];
  for (let i = 0; i < things.length; i++) {
    const a = things[i];
    const name = a.node ?? a.agent;
    assert.ok(insideIsland(a.x, a.z, a.radius), `${name} is off the island`);
    assert.ok(nearestOnPolyline(a, layout.terrain.river.points).d > layout.terrain.river.width / 2 + a.radius, `${name} stands in the river`);
    for (const m of layout.terrain.mountains) assert.ok(Math.hypot(a.x - m.x, a.z - m.z) > m.r * 0.9, `${name} stands inside a mountain`);
    assert.ok(nearestRoad(layout.terrain, a, 14), `${name} has no street near`);
    for (const b of things.slice(i + 1)) assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= a.radius + b.radius + 0.9, `${name} is on top of ${b.node ?? b.agent}`);
  }
});

test("styles vary with the kind of node, and never change", () => {
  const styles = new Set(layout.stations.map((s) => s.style));
  assert.ok(styles.size >= 9, `only ${[...styles].join(", ")}`);
  for (const s of layout.stations) {
    assert.deepEqual(styleFor(s), { style: s.style, scale: s.scale, radius: s.radius });
    assert.equal(s.radius, Math.round(STYLE_RADIUS[s.style] * s.scale * 100) / 100);
  }
  const of = (kind) => layout.stations.filter((s) => s.kind === kind && s.zone !== "platform").map((s) => s.style);
  assert.ok(of("database").every((st) => st === "tank"));
  assert.ok(of("cron-job").every((st) => st === "clock" || st === "windmill"));
  assert.ok(layout.stations.filter((s) => s.zone === "annex").every((s) => s.scale < 1), "annexes are smaller than the project they belong to");
});

test("the terrain has a river with bridges, mountains to the north and a way to walk everywhere", () => {
  const { river, mountains, bridges, graph } = layout.terrain;
  assert.ok(river.points.length > 30 && mountains.filter((m) => m.h > 8).length >= 5 && bridges.length >= 3);
  for (const b of bridges) assert.ok(nearestOnPolyline(b, river.points).d < 1.5, "a bridge sits on the river");
  assert.ok(mountains.filter((m) => m.h > 8).every((m) => m.z < -5), "the high mountains are along the north rim");
  const from = layout.desks[0].stand;
  for (const t of [...layout.desks, ...layout.stations]) assert.ok(shortestPath(graph, 0, 0).length >= 0 && routeBetween(layout, from, t.stand).length >= 0);
  const reached = new Set([0]);
  for (const queue = [0]; queue.length; ) for (const [v] of graph.adj[queue.pop()]) if (!reached.has(v)) { reached.add(v); queue.push(v); }
  assert.equal(reached.size, graph.nodes.length, "every road point and doorstep is connected");
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

test("a node resolves to its nearest building or house, through the tree", () => {
  assert.equal(locator.resolve("proj-finview").key, "station:proj-finview");
  assert.equal(locator.resolve("proj-finview-api").key, "station:proj-finview-api"); // a service has its own building
  assert.equal(locator.resolve("zb-hermes-eu-hermes").key, "station:zb-hermes-eu-hermes"); // Hermes' service on Zeabur has its own building
  assert.equal(locator.resolve("hermes-gateway-x-not-real"), null);
  assert.equal(locator.resolve("zeabur").key, "station:zeabur");
  assert.equal(locator.resolve("hermes").key, "desk:hermes"); // the agent's own node is its house
  assert.equal(locator.resolve("hermes-gateway").key, "station:hermes-gateway"); // what it runs has a workshop
  assert.equal(locator.resolve("hermes-weekly-upstream-sync").key, "desk:hermes"); // anything else of its is its house
  assert.equal(locator.resolve("fizz-bot-seodesk").key, "station:fizz-bot-seodesk");
  assert.equal(locator.resolve("vscode-workspace").key, "station:vscode-workspace");
  assert.equal(locator.resolve("cc-hooks").key, "desk:claude-code");
  assert.equal(locator.resolve("brais"), null);
  assert.equal(locator.resolve("not-on-the-map"), null);
});

// ---------- who is where ----------

test("without signals everyone sits at their own desk, idle", () => {
  const s = states([]);
  for (const d of layout.desks) {
    assert.equal(s[d.agent].mode, "idle");
    assert.deepEqual(s[d.agent].target, xz(d.stand));
    assert.equal(s[d.agent].text, "");
  }
});

test("a signal sends its agent to the station with the signal's text; the others stay put", () => {
  const s = states([sig({})]);
  const station = layout.stations.find((x) => x.node === "proj-finview");
  assert.equal(s["claude-code"].mode, "working");
  assert.deepEqual(s["claude-code"].target, xz(station.stand));
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
  const own = states([sig({ agent: "hermes", node: "hermes" })]).hermes;
  assert.equal(own.mode, "working");
  assert.deepEqual(own.target, xz(layout.desks.find((d) => d.agent === "hermes").stand));
  assert.deepEqual(states([sig({ node: "brais" })])["claude-code"].target, xz(layout.desks[0].stand));
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
  const gap = Math.hypot(s["claude-code"].target.x - s.hermes.target.x, s["claude-code"].target.z - s.hermes.target.z);
  assert.ok(gap >= 1 && gap <= 1.5, "side by side");
  const building = layout.stations.find((x) => x.node === "proj-finview");
  for (const who of ["claude-code", "hermes"]) assert.ok(Math.hypot(s[who].target.x - building.x, s[who].target.z - building.z) > building.radius, "never inside the building");

  const visit = states([sig({ node: "hermes" })]);
  assert.equal(visit["claude-code"].mode, "collaborating"); // Claude Code is at Hermes' desk
  assert.equal(visit.hermes.mode, "idle");
  assert.ok(Math.hypot(visit["claude-code"].target.x - visit.hermes.target.x, visit["claude-code"].target.z - visit.hermes.target.z) >= 1);
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

// ---------- walking around the buildings ----------

test("nobody walks through a building: no route between two doors enters another building", () => {
  const things = [...layout.desks, ...layout.stations];
  const stands = things.map((t) => t.stand);
  for (let n = 0; n < stands.length; n += 2) {
    const from = stands[n];
    for (let m = 0; m < stands.length; m += 3) {
      const to = stands[m];
      const route = routeBetween(layout, from, to);
      assert.deepEqual(route.length ? route.at(-1) : xz(from), xz(to), "the route ends at the door asked for");
      let prev = from;
      for (const next of route) {
        for (const b of things) assert.ok(distToSegment(b, prev, next).d >= b.radius - 0.15, `${JSON.stringify(from)} → ${JSON.stringify(to)} cuts through ${b.node ?? b.agent}`);
        assert.ok(insideIsland(next.x, next.z, 0), "the route stays on the island");
        prev = next;
      }
    }
  }
});

test("walking is by the road: close doors give a short walk, far ones a longer one that still ends right", () => {
  const near = layout.stations.find((s) => s.parentStation);
  const parent = layout.stations.find((s) => s.node === near.parentStation);
  const len = (r, from) => r.reduce((sum, p, i) => sum + Math.hypot(p.x - (i ? r[i - 1].x : from.x), p.z - (i ? r[i - 1].z : from.z)), 0);
  const short = routeBetween(layout, near.stand, parent.stand);
  assert.ok(len(short, near.stand) < 80);
  const far = routeBetween(layout, layout.desks[0].stand, layout.stations.at(-1).stand);
  assert.ok(far.length > 2 && len(far, layout.desks[0].stand) > 20);
  assert.ok(layout.stations.every((s) => s.stand.side && Math.abs(Math.hypot(s.stand.side.x, s.stand.side.z) - 1) < 0.05), "every doorstep knows its sideways");
});

test("a signal without an agent field still moves the right avatar (a server that predates it)", () => {
  for (const node of ["hermes-gateway", "zb-hermes-eu", "fizz-bot-seodesk", "buzz-relay", "proj-finview", "cc-hooks"]) {
    assert.equal(agentOf({ node }), agentForNode(node), node);
  }
  assert.equal(agentOf({ node: "hermes", agent: "gemini" }), "gemini");
  const bare = { id: "x", node: "proj-finview", kind: "working", text: "t", at: NOW - 1000 };
  assert.equal(states([bare])["claude-code"].mode, "working");
  assert.equal(states([{ ...bare, node: "hermes-gateway" }]).hermes.mode, "working");
});
