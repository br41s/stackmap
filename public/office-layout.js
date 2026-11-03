// The 3D office, as pure data: where each agent's desk and each project / infrastructure
// station stands, and where every agent should be right now given the signals. No DOM, no
// WebGL — office.js draws what this says; Node tests it. Units are metres on the floor plane:
// x runs east, z runs towards the camera (south).

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

// Which map nodes become stations: the children of `parent` of that `kind`.
export const ZONES = [
  { zone: "project", parent: "layer-products", kind: "project" }, // workstations
  { zone: "infra", parent: "layer-hosting", kind: "platform" },   // server racks
];

export const SPACING = { desk: 5.5, project: 4.4, rack: 2.8, rows: 4.8 };
const DESK_Z = -9;

// How long a signal keeps its agent at the station, by kind. The task decides, not a timer:
// `working` (a task started) and `waiting` (it needs the user) stay until the agent's next
// signal; the large value is only a safety net for a session that died without saying so.
// `done` is a short linger so the result can be read before the agent walks home; `info` is
// a note, gone quickly. Pass your own table to officeStates() to change any of them.
export const HOLD_MS = { working: 15 * 60_000, waiting: 15 * 60_000, done: 8_000, info: 12_000 };
export const holdMs = (signal, hold = HOLD_MS) => hold[signal?.kind] ?? hold.info ?? HOLD_MS.info;

const round = (n) => Math.round(n * 100) / 100;

// ---------- layout ----------

export function layoutOffice(stack, { agents = OFFICE_AGENTS, zones = ZONES } = {}) {
  const ids = new Set(stack.nodes.map((n) => n.id));

  const deskX = (i) => (i - (agents.length - 1) / 2) * SPACING.desk;
  const desks = agents.map((a, i) => {
    const node = a.nodes.find((id) => ids.has(id)) ?? null;
    const x = round(deskX(i));
    return { agent: a.id, label: a.label, color: a.color, node, reserved: node === null, x, z: DESK_Z, stand: { x, z: DESK_Z + 1.5 } };
  });

  const pick = ({ parent, kind }) => stack.nodes.filter((n) => n.parent === parent && n.kind === kind);

  // Projects: a centred grid, wider than tall.
  const projects = pick(zones.find((z) => z.zone === "project") ?? {});
  const cols = Math.max(1, Math.ceil(Math.sqrt(projects.length * 1.6)));
  const rows = Math.ceil(projects.length / cols);
  const gridZ0 = DESK_Z + 6;
  const stations = projects.map((n, i) => {
    const inRow = Math.min(cols, projects.length - Math.floor(i / cols) * cols);
    const x = round((i % cols - (inRow - 1) / 2) * SPACING.project);
    const z = round(gridZ0 + Math.floor(i / cols) * SPACING.rows);
    return { node: n.id, label: n.label, zone: "project", x, z, stand: { x, z: round(z + 1.5) } };
  });

  // Infrastructure: one row of racks south of the grid, people stand on the grid side.
  const infra = pick(zones.find((z) => z.zone === "infra") ?? {});
  const rackZ = round(gridZ0 + Math.max(rows, 1) * SPACING.rows + 2);
  infra.forEach((n, i) => {
    const x = round((i - (infra.length - 1) / 2) * SPACING.rack);
    stations.push({ node: n.id, label: n.label, zone: "infra", x, z: rackZ, stand: { x, z: round(rackZ - 1.6) } });
  });

  const xs = [...desks, ...stations].map((o) => o.x);
  const margin = 4;
  const bounds = {
    minX: round(Math.min(...xs, 0) - margin),
    maxX: round(Math.max(...xs, 0) + margin),
    minZ: round(DESK_Z - margin),
    maxZ: round(Math.max(rackZ, DESK_Z + 1.5) + margin),
  };
  return { bounds, desks, stations };
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
    if (!mine.has(s.agent)) continue; // an agent nobody sits for
    if (!latest.has(s.agent) || s.at >= latest.get(s.agent).at) latest.set(s.agent, s);
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
    return [st.agent, { ...out, target: { x: round(base.x + slotOffset(i, group.length)), z: base.z } }];
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
