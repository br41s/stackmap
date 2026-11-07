// The ground the office stands on, as pure geometry: the island's outline, the mountains along
// its north rim, the river, the roads and the graph of places people can walk. No DOM, no WebGL:
// office.js draws it, office-layout.js puts buildings on it, Node tests it. Units are metres,
// x runs east and z runs south (towards the default camera). Everything is hand-shaped but
// deterministic: the same village every time.

const round = (n) => Math.round(n * 100) / 100;

export const hash = (str) => [...String(str)].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7);
// A small seeded generator (mulberry32).
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- curves ----------

// Uniform Catmull-Rom through the points (open or closed), `per` samples per segment.
export function spline(points, per = 10, closed = false) {
  const n = points.length;
  const at = (i) => (closed ? points[((i % n) + n) % n] : points[Math.min(n - 1, Math.max(0, i))]);
  const out = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    for (let k = 0; k < per; k++) {
      const t = k / per;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), z: f(p0.z, p1.z, p2.z, p3.z) });
    }
  }
  if (!closed) out.push({ ...points[n - 1] });
  return out;
}

// The same curve with a point every `step` metres.
export function resample(points, step, closed = false) {
  const pts = closed ? [...points, points[0]] : points;
  const out = [{ ...pts[0] }];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    for (let d = step - carry; d <= len; d += step) out.push({ x: a.x + ((b.x - a.x) * d) / len, z: a.z + ((b.z - a.z) * d) / len });
    carry = (carry + len) % step;
  }
  if (!closed) out.push({ ...pts.at(-1) });
  return out.map((p) => ({ x: round(p.x), z: round(p.z) }));
}

export function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2)) : 0;
  const x = a.x + dx * t;
  const z = a.z + dz * t;
  return { d: Math.hypot(p.x - x, p.z - z), x, z, t };
}
export function nearestOnPolyline(p, pts) {
  let best = { d: Infinity, x: 0, z: 0, i: 0 };
  for (let i = 1; i < pts.length; i++) {
    const s = distToSegment(p, pts[i - 1], pts[i]);
    if (s.d < best.d) best = { ...s, i };
  }
  return best;
}

// ---------- the island ----------

const ISLAND = { a: 76, b: 62 };
// An ellipse with a few lobes, so the coast is not a shape anyone could have drawn with a ruler.
export function islandRadius(theta) {
  const { a, b } = ISLAND;
  const ellipse = (a * b) / Math.hypot(b * Math.cos(theta), a * Math.sin(theta));
  return ellipse * (1 + 0.06 * Math.sin(3 * theta + 0.7) + 0.035 * Math.sin(5 * theta + 2.1));
}
export const insideIsland = (x, z, margin = 0) => Math.hypot(x, z) <= islandRadius(Math.atan2(z, x)) - margin;
export function islandOutline(n = 120) {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    const r = islandRadius(t);
    return { x: round(Math.cos(t) * r), z: round(Math.sin(t) * r) };
  });
}

// ---------- terrain ----------

const RIVER = [[-8, -52], [-12, -32], [-18, -15], [-14, 0], [-6, 13], [-10, 27], [-4, 39], [1, 52], [5, 70]];
const RIVER_WIDTH = 3.6;
export const PLAZA = { x: 8, z: -6, r: 6.5 };
const P = (list) => list.map(([x, z]) => ({ x, z }));
// Streets: a few long, bendy ones across the island and some that cut through them.
const STREETS = [
  ["north", [[-8, -23], [4, -25], [22, -22], [40, -24], [56, -19], [68, -12]]],
  ["main", [[-66, -8], [-48, -9], [-30, -4], [-18, -8], [-4, -5], [8, -6], [22, -3], [38, -7], [54, -4], [70, -6]]],
  ["middle", [[-68, 9], [-48, 8], [-30, 12], [-14, 9], [2, 11], [18, 8], [34, 12], [52, 9], [68, 11]]],
  ["south", [[-62, 24], [-44, 22], [-26, 26], [-10, 23], [6, 25], [22, 22], [38, 26], [50, 23], [64, 26]]],
  ["harbour", [[-52, 38], [-36, 36], [-18, 40], [-2, 37], [14, 40], [30, 37], [44, 39], [58, 37]]],
  ["west lane", [[-33, -8], [-29, 4], [-34, 12], [-30, 24], [-27, 37]]],
  ["east lane", [[18, -23], [15, -10], [17, 2], [14, 12], [16, 24], [14, 39]]],
  ["far lane", [[38, -23], [35, -8], [37, 6], [34, 14], [36, 26], [37, 39]]],
  ["old road", [[-30, 28], [-16, 18], [-3, 5], [8, -6]]],
  ["edge lane", [[-45, -4], [-47, 10], [-43, 24], [-38, 36]]],
  ["west end", [[-60, -6], [-62, 10], [-58, 24], [-50, 38]]],
  ["south outer", [[-34, 49], [-14, 51], [6, 49], [26, 50], [46, 47]]],
  ["east outer", [[64, -10], [66, 6], [62, 22], [54, 36]]],
  ["mill lane", [[4, 12], [6, 24], [3, 38], [2, 51]]],
  ["market lane", [[25, -20], [26, 0], [28, 14], [26, 24], [27, 38]]],
  ["east end", [[48, -14], [50, 4], [47, 20], [44, 34]]],
  ["hill road", [[8, -6], [22, -14], [34, -23]]],
];

function clipToIsland(points, margin) {
  const runs = [];
  let run = [];
  for (const p of points) {
    if (insideIsland(p.x, p.z, margin)) run.push(p);
    else if (run.length) { runs.push(run); run = []; }
  }
  if (run.length) runs.push(run);
  return runs.filter((r) => r.length > 4);
}

export function buildTerrain() {
  // river: from the mountains to a waterfall over the south edge
  const riverAll = resample(spline(P(RIVER), 14), 1.5);
  const river = [];
  let mouth = null;
  for (const p of riverAll) {
    if (insideIsland(p.x, p.z, 0.5)) river.push(p);
    else if (river.length > 20) { mouth = river.at(-1); break; }
  }
  const mouthAngle = Math.atan2(mouth.x - river.at(-4).x, mouth.z - river.at(-4).z);

  // mountains along the north rim (leaving a gap for the river) and a few low hills elsewhere
  const r = rng(77);
  const mountains = [];
  for (let deg = -168; deg <= -12; deg += 15 + Math.floor(r() * 7)) {
    const t = (deg * Math.PI) / 180;
    const rim = islandRadius(t);
    const m = { x: round(Math.cos(t) * rim * (0.84 + r() * 0.07)), z: round(Math.sin(t) * rim * (0.84 + r() * 0.07)), r: round(8 + r() * 5), h: round(11 + r() * 8) };
    if (river.some((q) => Math.hypot(q.x - m.x, q.z - m.z) < m.r + 2.5)) continue;
    mountains.push(m);
  }
  for (const deg of [-5, 12, 172, 160, 62, 118]) {
    const t = (deg * Math.PI) / 180;
    const rim = islandRadius(t);
    mountains.push({ x: round(Math.cos(t) * rim * 0.9), z: round(Math.sin(t) * rim * 0.9), r: round(3.5 + r() * 2.5), h: round(2.5 + r() * 2.5) });
  }

  // roads: every street, cut where it would leave the island, plus a ring round the plaza
  const roads = [];
  for (const [name, pts] of STREETS) {
    const line = resample(spline(P(pts), 12), 2);
    clipToIsland(line, 5).forEach((run, i) => roads.push({ id: `${name}${i ? ` ${i + 1}` : ""}`, points: run, closed: false }));
  }
  const ring = [];
  for (let i = 0; i < 28; i++) ring.push({ x: round(PLAZA.x + Math.cos((i / 28) * Math.PI * 2) * (PLAZA.r - 0.4)), z: round(PLAZA.z + Math.sin((i / 28) * Math.PI * 2) * (PLAZA.r - 0.4)) });
  roads.push({ id: "plaza", points: ring, closed: true });

  // bridges where a road meets the river
  const bridges = [];
  for (const road of roads) {
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1];
      const b = road.points[i];
      const hit = nearestOnPolyline({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }, river);
      if (hit.d < 1.1 && !bridges.some((q) => Math.hypot(q.x - hit.x, q.z - hit.z) < 6)) {
        bridges.push({ x: round(hit.x), z: round(hit.z), angle: round(Math.atan2(b.x - a.x, b.z - a.z)), road: road.id });
      }
    }
  }

  const terrain = { island: ISLAND, outline: islandOutline(), river: { points: river, width: RIVER_WIDTH, mouth: { ...mouth, angle: round(mouthAngle) } }, mountains, roads, bridges, plaza: PLAZA };
  terrain.roadIndex = indexRoads(roads);
  terrain.graph = buildGraph(roads);
  return terrain;
}

// ---------- querying the terrain ----------

// A coarse grid of every road segment, so "how far is this spot from a road" is cheap.
function indexRoads(roads) {
  const cell = 8;
  const grid = new Map();
  const segs = [];
  for (const road of roads) {
    const pts = road.closed ? [...road.points, road.points[0]] : road.points;
    for (let i = 1; i < pts.length; i++) {
      const s = { a: pts[i - 1], b: pts[i] };
      const idx = segs.push(s) - 1;
      const [x0, x1] = [Math.min(s.a.x, s.b.x), Math.max(s.a.x, s.b.x)];
      const [z0, z1] = [Math.min(s.a.z, s.b.z), Math.max(s.a.z, s.b.z)];
      for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++) {
        for (let cz = Math.floor(z0 / cell); cz <= Math.floor(z1 / cell); cz++) {
          const key = `${cx},${cz}`;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(idx);
        }
      }
    }
  }
  return { cell, grid, segs };
}

// The closest point on any road within `within` metres (null if none).
export function nearestRoad(terrain, p, within = 12) {
  const { cell, grid, segs } = terrain.roadIndex;
  const reach = Math.ceil(within / cell);
  const cx = Math.floor(p.x / cell);
  const cz = Math.floor(p.z / cell);
  let best = null;
  const seen = new Set();
  for (let i = -reach; i <= reach; i++) {
    for (let j = -reach; j <= reach; j++) {
      for (const idx of grid.get(`${cx + i},${cz + j}`) ?? []) {
        if (seen.has(idx)) continue;
        seen.add(idx);
        const s = distToSegment(p, segs[idx].a, segs[idx].b);
        if (s.d <= within && (!best || s.d < best.d)) best = s;
      }
    }
  }
  return best;
}

// Can something of this radius stand here? On the island, off the river, the mountains and the plaza.
export function terrainAllows(terrain, x, z, radius) {
  if (!insideIsland(x, z, radius + 3)) return false;
  const half = terrain.river.width / 2;
  if (nearestOnPolyline({ x, z }, terrain.river.points).d < half + radius + 1.4) return false;
  if (terrain.mountains.some((m) => Math.hypot(x - m.x, z - m.z) < m.r * 0.95 + radius + 1)) return false;
  if (Math.hypot(x - terrain.plaza.x, z - terrain.plaza.z) < terrain.plaza.r + radius + 3.2) return false;
  return true;
}

// ---------- the walking graph ----------

// Road points joined along each road, and joined across roads where they cross (any two points of
// different roads within 2 m). Buildings add their own door points later with connect().
function buildGraph(roads) {
  const nodes = [];
  const adj = [];
  const owner = [];
  const link = (i, j, w = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].z - nodes[j].z)) => {
    adj[i].push([j, w]);
    adj[j].push([i, w]);
  };
  roads.forEach((road, ri) => {
    const first = nodes.length;
    road.points.forEach((p) => {
      nodes.push({ x: p.x, z: p.z });
      adj.push([]);
      owner.push(ri);
    });
    for (let i = first + 1; i < nodes.length; i++) link(i - 1, i);
    if (road.closed) link(nodes.length - 1, first);
  });
  const cell = 2.5;
  const grid = new Map();
  nodes.forEach((n, i) => {
    const key = `${Math.floor(n.x / cell)},${Math.floor(n.z / cell)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  });
  nodes.forEach((n, i) => {
    const cx = Math.floor(n.x / cell);
    const cz = Math.floor(n.z / cell);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        for (const j of grid.get(`${cx + a},${cz + b}`) ?? []) {
          if (j <= i || owner[j] === owner[i]) continue;
          if (Math.hypot(nodes[j].x - n.x, nodes[j].z - n.z) < 2.6) link(i, j);
        }
      }
    }
  });
  return { nodes, adj, roadNodes: nodes.length };
}

export function nearestNode(graph, p, roadsOnly = false) {
  let best = -1;
  let bestD = Infinity;
  const n = roadsOnly ? graph.roadNodes : graph.nodes.length;
  for (let i = 0; i < n; i++) {
    const d = (graph.nodes[i].x - p.x) ** 2 + (graph.nodes[i].z - p.z) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// A new point on the graph (a doorstep), joined to the nearest road point.
export function connect(graph, p) {
  const to = nearestNode(graph, p, true);
  const i = graph.nodes.push({ x: round(p.x), z: round(p.z) }) - 1;
  graph.adj.push([]);
  const w = Math.hypot(graph.nodes[to].x - p.x, graph.nodes[to].z - p.z);
  graph.adj[i].push([to, w]);
  graph.adj[to].push([i, w]);
  return i;
}

// Dijkstra over the graph. Returns the node indices from `from` to `to` (empty if unreachable).
export function shortestPath(graph, from, to) {
  const dist = new Map([[from, 0]]);
  const prev = new Map();
  const heap = [[0, from]];
  const push = (item) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent][0] <= heap[i][0]) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, u] = pop();
    if (u === to) break;
    if (d > (dist.get(u) ?? Infinity)) continue;
    for (const [v, w] of graph.adj[u]) {
      const nd = d + w;
      if (nd < (dist.get(v) ?? Infinity)) {
        dist.set(v, nd);
        prev.set(v, u);
        push([nd, v]);
      }
    }
  }
  if (from !== to && !prev.has(to)) return [];
  const path = [to];
  while (path[0] !== from) path.unshift(prev.get(path[0]));
  return path;
}
