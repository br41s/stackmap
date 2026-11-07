// The 3D office, as pure data: the village (where each agent's house and every project, service
// and hosting building stands, the roads between them) and where every agent should be right now
// given the signals. No DOM, no WebGL — office.js draws what this says; Node tests it. Units are
// metres on the ground plane: x runs east, z runs south (towards the default camera). The ground
// itself — island, mountains, river, roads, walking graph — is in village.js.
import { PLAZA, buildTerrain, connect, distToSegment, hash, nearestNode, nearestRoad, rng, shortestPath, terrainAllows } from "./village.js";
export { hash, rng };

// One desk per agent. `nodes` are the map ids a desk opens when clicked (the first one on the
// map wins); an agent with none on the map has a reserved desk — seated, dimmed, not clickable.
// Add an entry here to seat another collaborator. Ids match AGENTS in lib/signals.mjs.
export const OFFICE_AGENTS = [
  { id: "claude-code", label: "Claude Code", color: "#ffb547", nodes: ["claude-code"] },
  { id: "hermes", label: "Hermes", color: "#b47cff", nodes: ["hermes"] },
  { id: "buzz", label: "Buzz / Fizz", color: "#ff79c6", nodes: ["buzz"] },
  { id: "gemini", label: "Gemini", color: "#5b9dff", nodes: ["ext-gemini"] },
  { id: "chatgpt", label: "ChatGPT", color: "#38d989", nodes: ["ext-chatgpt", "ext-openai"] },
];


// How long a signal keeps its agent at the station, by kind. The task decides, not a timer:
// `working` (a task started) and `waiting` (it needs the user) stay until the agent's next
// signal; the large value is only a safety net for a session that died without saying so.
// `done` is a short linger so the result can be read before the agent walks home; `info` is
// a note, gone quickly. Pass your own table to officeStates() to change any of them.
export const HOLD_MS = { working: 15 * 60_000, waiting: 15 * 60_000, done: 12_000, info: 12_000 };
export const holdMs = (signal, hold = HOLD_MS) => hold[signal?.kind] ?? hold.info ?? HOLD_MS.info;

const round = (n) => Math.round(n * 100) / 100;

// ---------- buildings: which map nodes get one, and in what style ----------

// What each style covers on the ground (a circle: nobody walks through it, and a test checks it).
export const STYLE_RADIUS = { home: 2.3, cottage: 1.9, townhouse: 1.6, shop: 1.9, barn: 2.3, aframe: 1.7, thai: 2.1, greenhouse: 1.8, warehouse: 2.3, tank: 1.3, yurt: 1.4, kiosk: 1.0, clock: 1.3, windmill: 1.6, silo: 1.2, lighthouse: 1.4 };
const POOLS = {
  project: ["cottage", "townhouse", "shop", "barn", "aframe", "thai", "greenhouse", "shop", "cottage", "thai"],
  platform: ["silo", "lighthouse", "silo", "lighthouse", "silo"],
  annex: {
    service: ["shop", "cottage", "aframe", "greenhouse", "kiosk", "townhouse"], tool: ["yurt", "kiosk", "windmill"], agent: ["yurt", "cottage"],
    "cron-job": ["clock", "windmill"], hook: ["kiosk"], config: ["kiosk"], doc: ["kiosk", "greenhouse"], server: ["warehouse"], project: ["cottage", "thai"],
  },
  hosting: { project: ["warehouse", "barn", "aframe", "greenhouse"], server: ["warehouse"], database: ["tank"], service: ["warehouse", "shop", "cottage", "aframe"] },
  // an agent's own workshops: the services, servers and bots it runs, next to its house
  workshop: { service: ["greenhouse", "shop", "aframe", "townhouse"], server: ["warehouse"], bot: ["yurt", "aframe", "kiosk"], repo: ["townhouse", "barn"], "mcp-server": ["kiosk", "windmill"] },
};
// The style of a building, chosen by the kind of node and its id, so it never changes.
export function styleFor({ node, kind, zone }) {
  const seed = hash(node);
  const pool = zone === "project" ? POOLS.project : zone === "platform" ? POOLS.platform : zone === "annex" ? POOLS.annex[kind] ?? ["cottage"] : zone === "workshop" ? POOLS.workshop[kind] ?? ["cottage"] : POOLS.hosting[kind] ?? ["warehouse"];
  const style = pool[seed % pool.length];
  const scale = zone === "annex" ? 0.8 : zone === "hosting" || zone === "workshop" ? 0.85 : zone === "platform" ? 1.1 : 1;
  return { style, scale, radius: Math.round(STYLE_RADIUS[style] * scale * 100) / 100 };
}

const HOSTING_KINDS = new Set(["project", "server", "database", "service"]);
// What an agent runs besides its house gets a workshop beside it, so activity on those nodes
// (the Hermes gateway, a Fizz bot, the workspace…) makes the agent walk there instead of staying
// at the door. Everything of these kinds below the agent's home, and a few named places that sit
// elsewhere in the tree.
const WORKSHOP_KINDS = new Set(["service", "server", "bot"]);
const WORKSHOP_EXTRA = { "claude-code": ["vscode-workspace", "mcp-hub", "hf-hub"], buzz: ["fizz"] };

// Every project with the services, tools and jobs inside it as annexes beside it; every hosting
// platform with its projects, databases and services around it. Parents come before children.
export function collectStations(stack, agents = OFFICE_AGENTS) {
  const byId = new Map(stack.nodes.map((n) => [n.id, n]));
  const kids = new Map();
  for (const n of stack.nodes) if (n.parent) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
  const size = (id) => 1 + (kids.get(id) ?? []).reduce((sum, k) => sum + size(k.id), 0);
  const out = [];
  const add = (n, zone, parentStation, depth) => out.push({ node: n.id, label: n.label, kind: n.kind, zone, parentStation, depth, weight: size(n.id) });
  for (const top of stack.nodes.filter((n) => n.parent === "layer-products" && n.kind === "project")) {
    add(top, "project", null, 1);
    for (const c of kids.get(top.id) ?? []) add(c, "annex", top.id, 2);
  }
  const walk = (n, parentStation, depth) => {
    for (const c of kids.get(n.id) ?? []) {
      if (depth + 1 > 3 || !HOSTING_KINDS.has(c.kind)) continue;
      add(c, "hosting", parentStation, depth + 1);
      walk(c, c.id, depth + 1);
    }
  };
  for (const p of stack.nodes.filter((n) => n.parent === "layer-hosting" && n.kind === "platform")) {
    add(p, "platform", null, 1);
    walk(p, p.id, 1);
  }
  void byId;

  const taken = new Set(out.map((e) => e.node));
  for (const agent of agents) {
    const home = agent.nodes.find((id) => byId.has(id));
    if (!home) continue;
    const mine = new Map(); // node → depth below the home
    const walkHome = (id, d) => {
      for (const c of kids.get(id) ?? []) {
        if (d + 1 <= 3 && WORKSHOP_KINDS.has(c.kind) && !taken.has(c.id)) mine.set(c.id, d + 1);
        if (d + 1 < 3) walkHome(c.id, d + 1);
      }
    };
    walkHome(home, 0);
    for (const id of WORKSHOP_EXTRA[agent.id] ?? []) if (byId.has(id) && !taken.has(id)) mine.set(id, 1);
    const nearest = (id) => { // the closest ancestor that has a workshop of its own
      for (let cur = byId.get(id)?.parent; cur; cur = byId.get(cur)?.parent) if (mine.has(cur)) return cur;
      return null;
    };
    for (const [id, depth] of [...mine].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))) {
      const n = byId.get(id);
      out.push({ node: n.id, label: n.label, kind: n.kind, zone: "workshop", agent: agent.id, parentStation: nearest(id), depth, weight: size(n.id) });
    }
  }
  return out;
}

// ---------- the village ----------

export function layoutOffice(stack, { agents = OFFICE_AGENTS } = {}) {
  const terrain = buildTerrain();
  const graph = terrain.graph;
  const ids = new Set(stack.nodes.map((n) => n.id));
  const r = rng(4242);
  const placed = []; // { x, z, r }

  // The walk from a door to the street (to the road point the doorstep is joined to) must not
  // cross another building, and no building may be put across a walk already made.
  const paths = [];
  const doorPath = (x, z, radius) => {
    const road = nearestRoad(terrain, { x, z }, 40);
    if (!road) return null;
    const len = Math.hypot(road.x - x, road.z - z) || 1;
    const stand = { x: x + ((road.x - x) / len) * (radius + 0.95), z: z + ((road.z - z) / len) * (radius + 0.95) };
    return { stand, to: graph.nodes[nearestNode(graph, stand, true)] };
  };
  const doorClear = (x, z, radius) => {
    const path = doorPath(x, z, radius);
    if (!path) return false;
    return placed.every((q) => distToSegment(q, path.stand, path.to).d >= q.r + 0.4) && paths.every((p) => distToSegment({ x, z }, p.stand, p.to).d >= radius + 0.35);
  };
  const clear = (x, z, radius) =>
    terrainAllows(terrain, x, z, radius) && placed.every((q) => Math.hypot(x - q.x, z - q.z) >= q.r + radius + 1.0) && !nearestRoad(terrain, { x, z }, radius + 1.2) && doorClear(x, z, radius);

  // building plots along every street, a few metres back, with gaps and wobble
  const slots = [];
  for (const road of terrain.roads.filter((rd) => rd.id !== "plaza")) {
    let along = r() * 3;
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1];
      const b = road.points[i];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const tx = (b.x - a.x) / len;
      const tz = (b.z - a.z) / len;
      along -= len;
      if (along > 0) continue;
      along += 5.4 + r() * 2.2;
      for (const side of [-1, 1]) {
        if (r() < 0.1) continue;
        const slide = (r() - 0.5) * 1.4;
        // a plot at the street, one side closer than the other, and a second row behind
        for (const back of [(side > 0 ? 3.9 : 4.7) + r() * 0.9, 10.4 + r() * 1.4]) {
          const shift = back > 8 ? 3.1 : 0; // the second row sits between the buildings in front
          slots.push({ x: Math.round((a.x - tz * side * back + tx * (slide + shift)) * 100) / 100, z: Math.round((a.z + tx * side * back + tz * (slide + shift)) * 100) / 100 });
        }
      }
    }
  }

  // The closest plot to `near` where `radius` fits; failing that, anywhere round `near` that is
  // close enough to a street to walk from.
  const findSpot = (radius, near, jitter = 0) => {
    let best = null;
    for (const s of slots) {
      const d = Math.hypot(s.x - near.x, s.z - near.z) + (jitter ? r() * jitter : 0);
      if ((!best || d < best.d) && clear(s.x, s.z, radius)) best = { d, x: s.x, z: s.z };
    }
    if (best) return best;
    for (let ring = 3; ring < 40; ring += 1.6) {
      for (let k = 0; k < 24; k++) {
        const t = (k / 24) * Math.PI * 2 + ring;
        const x = near.x + Math.cos(t) * ring;
        const z = near.z + Math.sin(t) * ring;
        if (clear(x, z, radius) && nearestRoad(terrain, { x, z }, 16)) return { x, z };
      }
    }
    throw new Error(`no room left in the village for a building of radius ${radius} (${placed.length} placed, ${slots.length} plots)`);
  };

  // A building: its centre, which way its door faces (the nearest street), and the doorstep.
  const build = (x, z, radius, facing) => {
    placed.push({ x, z, r: radius });
    const road = facing ?? nearestRoad(terrain, { x, z }, 40);
    const dx = road.x - x;
    const dz = road.z - z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    const stand = { x: Math.round((x + ux * (radius + 0.95)) * 100) / 100, z: Math.round((z + uz * (radius + 0.95)) * 100) / 100 };
    paths.push({ stand, to: graph.nodes[nearestNode(graph, stand, true)] });
    const index = connect(graph, stand);
    return { rot: Math.round(Math.atan2(ux, uz) * 100) / 100, stand: { ...stand, side: { x: Math.round(uz * 100) / 100, z: Math.round(-ux * 100) / 100 } }, graphNode: index };
  };

  // agents' houses: round the plaza, spread as far apart as the streets allow
  const homeR = STYLE_RADIUS.home;
  const ringR = PLAZA.r + homeR + 3.6;
  const angles = [];
  for (let deg = 0; deg < 360; deg += 6) {
    const t = (deg * Math.PI) / 180;
    if (clear(PLAZA.x + Math.cos(t) * ringR, PLAZA.z + Math.sin(t) * ringR, homeR)) angles.push(t);
  }
  const apart = (a, b) => Math.abs(((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  const chosen = [];
  for (const _ of agents) {
    const pool = angles.filter((a) => !chosen.includes(a));
    if (!pool.length) throw new Error("no room round the plaza for every agent");
    chosen.push(chosen.length ? pool.reduce((best, a) => (Math.min(...chosen.map((c) => apart(a, c))) > Math.min(...chosen.map((c) => apart(best, c))) ? a : best)) : pool[Math.floor(pool.length / 4)]);
  }
  chosen.sort((a, b) => a - b);
  const desks = agents.map((a, i) => {
    const node = a.nodes.find((id) => ids.has(id)) ?? null;
    const t = chosen[i];
    const x = Math.round((PLAZA.x + Math.cos(t) * ringR) * 100) / 100;
    const z = Math.round((PLAZA.z + Math.sin(t) * ringR) * 100) / 100;
    const b = build(x, z, homeR, nearestRoad(terrain, { x, z }, 12));
    return { agent: a.id, label: a.label, color: a.color, node, reserved: node === null, x, z, style: "home", scale: 1, radius: homeR, ...b };
  });

  // projects near the middle of town, big ones first; their services beside them
  const all = collectStations(stack, agents);
  const byParent = new Map();
  for (const e of all) if (e.parentStation) byParent.set(e.parentStation, [...(byParent.get(e.parentStation) ?? []), e]);
  const stations = [];
  const put = (e, near, jitter) => {
    const st = styleFor(e);
    const spot = findSpot(st.radius, near, jitter);
    const b = build(spot.x, spot.z, st.radius);
    const rec = { ...e, ...st, x: spot.x, z: spot.z, ...b };
    stations.push(rec);
    for (const c of (byParent.get(e.node) ?? []).sort((p, q) => q.weight - p.weight || p.node.localeCompare(q.node))) put(c, rec, 0);
    return rec;
  };
  // each agent's workshops, beside its house, before the town fills the streets round the plaza
  for (const e of all.filter((x) => x.zone === "workshop" && !x.parentStation)) put(e, desks.find((d) => d.agent === e.agent), 2);
  const projects = all.filter((e) => e.zone === "project").sort((a, b) => b.weight - a.weight || a.node.localeCompare(b.node));
  projects.forEach((e) => put(e, { x: PLAZA.x - 6, z: PLAZA.z + 6 }, 6));
  // hosting along the southern streets, platforms spread out with everything of theirs near them
  const platforms = all.filter((e) => e.zone === "platform");
  platforms.forEach((e, i) => put(e, { x: -34 + (i * 72) / Math.max(platforms.length - 1, 1), z: 30 + (i % 2) * 8 }, 3));

  // the camera frames the island
  const reach = terrain.outline.reduce((m, p) => ({ x0: Math.min(m.x0, p.x), x1: Math.max(m.x1, p.x), z0: Math.min(m.z0, p.z), z1: Math.max(m.z1, p.z) }), { x0: 0, x1: 0, z0: 0, z1: 0 });
  const bounds = { minX: Math.round(reach.x0), maxX: Math.round(reach.x1), minZ: Math.round(reach.z0), maxZ: Math.round(reach.z1) };
  return { bounds, desks, stations, terrain, graph };
}

// ---------- where people may walk ----------

// The corners to walk, in order, from `from` to `to` (not including `from`): onto the nearest
// road point, along the roads the short way, and off to the door. Corners that barely turn are dropped.
export function routeBetween(layout, from, to) {
  const g = layout.graph;
  const a = nearestNode(g, from);
  const b = nearestNode(g, to);
  const nodes = shortestPath(g, a, b).map((i) => g.nodes[i]);
  const pts = [...nodes, to];
  const out = [];
  let last = from;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const next = pts[i + 1];
    const far = Math.hypot(p.x - last.x, p.z - last.z);
    if (far < 0.05) continue;
    const prev = out.length ? out.at(-1) : from;
    const turns = next ? Math.abs(Math.atan2(p.x - prev.x, p.z - prev.z) - Math.atan2(next.x - p.x, next.z - p.z)) : 1;
    if (!next || far >= 3 || (turns > 0.16 && turns < 6.1)) {
      out.push({ x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100 });
      last = p;
    }
  }
  return out;
}

// ---------- which object a map node belongs to ----------

// A signal names a node deep in the tree (proj-finview-api); the office has one object per
// station or desk. The nearest ancestor (itself included) that has one decides; null = none.
export function createLocator(stack, layout) {
  const parentOf = new Map(stack.nodes.map((n) => [n.id, n.parent ?? null]));
  const stationAt = new Map(layout.stations.map((s) => [s.node, s]));
  const deskAt = new Map(layout.desks.filter((d) => d.node).map((d) => [d.node, d]));
  return {
    resolve(id) {
      for (let cur = id, hops = 0; cur && hops < 64; cur = parentOf.get(cur), hops++) {
        if (stationAt.has(cur)) return { type: "station", key: `station:${cur}`, stand: stationAt.get(cur).stand, node: cur };
        if (deskAt.has(cur)) return { type: "desk", key: `desk:${deskAt.get(cur).agent}`, stand: deskAt.get(cur).stand, node: cur };
      }
      return null;
    },
  };
}

// ---------- who is where ----------

// Who sent a signal: the agent it names, else the one its node belongs to — the same rule as
// agentForNode() in lib/signals.mjs (a test keeps them equal), so a server that predates the
// agent field still moves the right avatar.
export const agentOf = (s) => s.agent ?? (/^(hermes|zb-hermes)/.test(s.node) ? "hermes" : /^(buzz|fizz)/.test(s.node) ? "buzz" : "claude-code");

// The signals list as the page keeps it: oldest first, one entry per id, at most `cap`.
export function pushSignal(list, signal, cap = 60) {
  if (!signal || list.some((s) => s.id === signal.id)) return list;
  return [...list, signal].sort((a, b) => a.at - b.at).slice(-cap);
}

// x offsets that spread n people around a point, `gap` apart.
export const slotOffset = (i, n, gap = 1.2) => round((i - (n - 1) / 2) * gap);

// Where every agent should be at `now`, and what it is doing:
//   idle           at its own desk (no signal inside its hold time)
//   working        at the station / desk its latest signal names, with that signal's text
//   waiting        same, but the signal asks for the user (kind "waiting")
//   done           same, just finished: the result stays up for the linger, then it walks home
//   collaborating  working while someone else is at the same station or desk
// Pure: the renderer walks avatars to `target`, so "walking" is just the gap between the two.
export function officeStates({ layout, locator, signals, now, hold = HOLD_MS }) {
  const mine = new Map(layout.desks.map((d) => [d.agent, d]));
  const latest = new Map();
  for (const s of signals) {
    const who = agentOf(s);
    if (!mine.has(who)) continue; // an agent nobody sits for
    if (!latest.has(who) || s.at >= latest.get(who).at) latest.set(who, s);
  }

  const states = layout.desks.map((desk) => {
    const s = latest.get(desk.agent);
    const home = { agent: desk.agent, mode: "idle", key: `desk:${desk.agent}`, node: desk.node, kind: null, text: "", signalId: null, base: desk.stand };
    if (!s || now - s.at >= holdMs(s, hold) || now < s.at) return home;
    const place = locator.resolve(s.node) ?? { key: home.key, stand: desk.stand };
    return { ...home, mode: s.kind === "waiting" ? "waiting" : s.kind === "done" ? "done" : "working", key: place.key, node: s.node, kind: s.kind, text: s.text, signalId: s.id, base: place.stand };
  });

  const groups = new Map();
  for (const st of states) groups.set(st.key, [...(groups.get(st.key) ?? []), st]);
  return Object.fromEntries(states.map((st) => {
    const group = groups.get(st.key);
    const i = group.indexOf(st);
    const { base, ...out } = st;
    if (group.length > 1 && st.mode === "working") out.mode = "collaborating";
    // side by side along the front of the building, never towards its walls
    const off = slotOffset(i, group.length);
    const side = base.side ?? { x: 1, z: 0 };
    return [st.agent, { ...out, target: { x: round(base.x + side.x * off), z: round(base.z + side.z * off) } }];
  }));
}

// One step of walking towards a target: returns the new position and whether it is there.
// Already there, or no distance to walk (a zero or negative step), never divides by zero.
export function stepToward(pos, target, distance) {
  const dx = target.x - pos.x;
  const dz = target.z - pos.z;
  const left = Math.hypot(dx, dz);
  if (left === 0) return { pos: { x: target.x, z: target.z }, arrived: true, heading: 0 };
  if (distance <= 0) return { pos: { x: pos.x, z: pos.z }, arrived: false, heading: Math.atan2(dx, dz) };
  if (left <= distance) return { pos: { x: target.x, z: target.z }, arrived: true, heading: Math.atan2(dx, dz) };
  return { pos: { x: pos.x + (dx / left) * distance, z: pos.z + (dz / left) * distance }, arrived: false, heading: Math.atan2(dx, dz) };
}

