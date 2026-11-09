// The village's building blocks, drawn with plain three.js: rounded toy-like houses in a dozen
// styles, trees, lamps, clouds, birds and the little characters. Everything is procedural — no
// models, no image files. Static shapes are baked into a few big meshes (bake()) so a village of
// a hundred buildings costs a few dozen draw calls; what has to change while it runs (a house's
// windows, a windmill's sails, an avatar) is built unbaked.
import * as THREE from "/vendor/three.module.js";
import { hash, rng } from "./village.js";

export const PALETTE = {
  grass: "#9fd682", soil: "#b98b62", soilDark: "#9a7050", sand: "#f2e0b8", sandDark: "#dcc9a0", wood: "#c8915a", woodDark: "#8f633c",
  stone: "#d9d3c7", cream: "#fff3dc", leaf: "#6fbf73", leafDark: "#58a862", trunk: "#a1714a", glass: "#ffe6a8", water: "#6cc3e6",
};
const WALLS = ["#fff1da", "#ffe6c9", "#f7ead4", "#eaf3df", "#fde4ea", "#e4eefb", "#f4d9c2", "#dcebd6"];
const ROOFS = ["#e8795f", "#f2b34c", "#6fb7c9", "#c98bd1", "#7fc47e", "#e98fa6", "#8a9be0", "#d9695a"];
const SILOS = ["#a9d6f5", "#bfe8cf", "#d8c7f0", "#ffd7b0", "#f7c6d3"];
const pick = (list, seed) => list[seed % list.length];

// ---------- materials ----------

const cache = new Map();
// A cached standard material (so baking can merge everything that shares one). `unique` makes a
// private copy for the few things that animate on their own.
export function mat(color, { rough = 0.85, metal = 0, emissive = null, glow = 1, flat = false, opacity = 1, unique = false, side } = {}) {
  const key = [color, rough, metal, emissive, glow, flat, opacity, side].join("|");
  if (!unique && cache.has(key)) return cache.get(key);
  const params = { color, roughness: rough, metalness: metal, emissive: emissive ?? 0x000000, emissiveIntensity: emissive ? glow : 0, flatShading: flat, transparent: opacity < 1, opacity };
  if (side !== undefined) params.side = side; // three warns about an explicit undefined
  const m = new THREE.MeshStandardMaterial(params);
  if (!unique) cache.set(key, m);
  return m;
}
// Lamp bulbs share one material, so the whole village's street lamps turn on with one number.
export const lampMat = mat("#fff0b8", { emissive: "#ffd98a", glow: 0.2, unique: true });

// ---------- shapes ----------

export function shadowed(mesh, { cast = true, receive = true } = {}) {
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  return mesh;
}
// A box with rounded edges and corners: an extruded rectangle whose bevel is the rounding.
export function rbox(w, h, d, r, material, x = 0, y = 0, z = 0) {
  const k = Math.max(0.005, Math.min(r, w / 2 - 0.005, h / 2 - 0.005, d / 2 - 0.005));
  const shape = new THREE.Shape();
  shape.moveTo(-(w / 2 - k), -(h / 2 - k));
  shape.lineTo(w / 2 - k, -(h / 2 - k));
  shape.lineTo(w / 2 - k, h / 2 - k);
  shape.lineTo(-(w / 2 - k), h / 2 - k);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(d - 2 * k, 0.001), bevelEnabled: true, bevelThickness: k, bevelSize: k, bevelSegments: 2, curveSegments: 1 });
  g.translate(0, 0, -(d - 2 * k) / 2);
  const m = shadowed(new THREE.Mesh(g, material));
  m.position.set(x, y, z);
  return m;
}
export function ball(r, material, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, cast = true) {
  const m = shadowed(new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), material), { cast });
  m.position.set(x, y, z);
  m.scale.set(sx, sy, sz);
  return m;
}
export function cyl(rt, rb, h, material, x = 0, y = 0, z = 0, seg = 20) {
  const m = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), material));
  m.position.set(x, y, z);
  return m;
}
export function cone(r, h, material, x = 0, y = 0, z = 0, seg = 16) {
  const m = shadowed(new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), material));
  m.position.set(x, y, z);
  return m;
}
// An extruded outline (a triangle for a gable, a pentagon for a barn roof…), centred on z.
export function prism(points, depth, material, bevel = 0.06) {
  const s = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 1 });
  g.translate(0, 0, -depth / 2);
  return shadowed(new THREE.Mesh(g, material));
}
const gable = (w, rise, d, material) => prism([[-w / 2, 0], [w / 2, 0], [0, rise]], d, material, 0.07);

export function canvasTexture(size, draw, { repeat = false } = {}) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d"), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
export const dotTexture = () => canvasTexture(64, (g, s) => {
  const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.5, "rgba(255,255,255,0.55)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, s, s);
});

// ---------- baking ----------

// Merge every static mesh under `root` into one mesh per material (and shadow setting). Meshes
// flagged userData.keep stay as they are, with their parents' transforms.
export function bake(root) {
  root.updateMatrixWorld(true);
  const buckets = new Map();
  const doomed = [];
  root.traverse((o) => {
    if (!o.isMesh || o.userData.keep || Array.isArray(o.material)) return;
    doomed.push(o);
    const key = `${o.material.uuid}|${o.castShadow}|${o.receiveShadow}`;
    if (!buckets.has(key)) buckets.set(key, { material: o.material, cast: o.castShadow, receive: o.receiveShadow, parts: [] });
    const g = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()).applyMatrix4(o.matrixWorld);
    buckets.get(key).parts.push(g);
  });
  for (const o of doomed) {
    o.parent?.remove(o);
    o.geometry.dispose();
  }
  const merged = [];
  for (const { material, cast, receive, parts } of buckets.values()) {
    const count = parts.reduce((n, g) => n + g.attributes.position.count, 0);
    const position = new Float32Array(count * 3);
    const normal = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    let at = 0;
    for (const g of parts) {
      position.set(g.attributes.position.array, at * 3);
      if (g.attributes.normal) normal.set(g.attributes.normal.array, at * 3);
      if (g.attributes.uv) uv.set(g.attributes.uv.array, at * 2);
      at += g.attributes.position.count;
      g.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    merged.push(mesh);
  }
  return merged;
}

// ---------- buildings ----------

// Pieces most houses share. `glass` is the building's own window material (it lights up).
function windowAt(g, glass, x, y, z, w = 0.52, h = 0.52, box = true) {
  const frame = mat(PALETTE.wood, { rough: 0.8 });
  g.add(rbox(w + 0.18, h + 0.18, 0.08, 0.05, frame, x, y, z));
  const pane = rbox(w, h, 0.08, 0.04, glass, x, y, z + 0.04);
  pane.userData.keep = true;
  g.add(pane);
  g.add(rbox(0.04, h, 0.1, 0.01, frame, x, y, z + 0.07), rbox(w, 0.04, 0.1, 0.01, frame, x, y, z + 0.07));
  if (box) {
    g.add(rbox(w + 0.16, 0.14, 0.22, 0.04, frame, x, y - h / 2 - 0.2, z + 0.12));
    for (const k of [-0.2, 0, 0.2]) g.add(ball(0.08, mat(pick(["#ff8fa8", "#ffd45e", "#ffffff", "#c98bd1"], hash(`${x}${y}${k}`))), x + k * w * 1.1, y - h / 2 - 0.08, z + 0.14, 1, 1, 1, false));
  }
}
function doorAt(g, x, z, w = 0.62, h = 1.15, color = PALETTE.woodDark) {
  g.add(rbox(w, h, 0.12, 0.05, mat(color, { rough: 0.8 }), x, h / 2 + 0.06, z + 0.02));
  g.add(ball(0.045, mat("#ffd45e", { metal: 0.6, rough: 0.4 }), x + w * 0.28, h / 2, z + 0.1));
  g.add(rbox(w + 0.35, 0.09, 0.42, 0.04, mat(PALETTE.stone, { rough: 0.95 }), x, 0.06, z + 0.2));
}
function lampAt(g, x, y, z) {
  g.add(ball(0.09, lampMat, x, y, z, 1, 1, 1, false));
}
const awning = (g, w, y, z, accent) => {
  const slats = 6;
  for (let i = 0; i < slats; i++) {
    const sw = w / slats;
    const s = rbox(sw * 0.96, 0.06, 0.62, 0.03, mat(i % 2 ? "#ffffff" : accent), -w / 2 + sw * (i + 0.5), y, z + 0.3);
    s.rotation.x = 0.4;
    g.add(s);
  }
};

function cottage({ w = 3.0, d = 2.4, h = 1.9, wall, roof, accent, shop, ridgeX, chimney, glass }) {
  const g = new THREE.Group();
  const wallM = mat(wall);
  const roofM = mat(roof, { rough: 0.7 });
  g.add(rbox(w, h, d, 0.16, wallM, 0, h / 2, 0));
  g.add(rbox(w + 0.15, 0.16, d + 0.15, 0.06, mat(PALETTE.stone, { rough: 0.95 }), 0, 0.08, 0));
  const rise = Math.min(1.1, w * 0.3);
  const rf = ridgeX ? gable(d + 0.55, rise, w + 0.55, roofM) : gable(w + 0.55, rise, d + 0.55, roofM);
  if (ridgeX) rf.rotation.y = Math.PI / 2;
  rf.position.y = h - 0.02;
  g.add(rf);
  if (chimney) {
    g.add(rbox(0.34, 0.8, 0.34, 0.05, mat("#c9694f"), w / 2 - 0.55, h + rise * 0.55, -d / 4), rbox(0.42, 0.08, 0.42, 0.03, mat(PALETTE.stone), w / 2 - 0.55, h + rise * 0.55 + 0.42, -d / 4));
  }
  doorAt(g, 0, d / 2);
  lampAt(g, -0.55, 1.05, d / 2 + 0.08);
  for (const s of w > 2.6 ? [-1, 1] : [1]) windowAt(g, glass, s * (w / 2 - 0.62), h * 0.58, d / 2);
  if (shop) awning(g, w - 0.3, h * 0.86, d / 2, accent);
  return { group: g, top: h + rise };
}

function townhouse({ wall, roof, glass }) {
  const g = new THREE.Group();
  const w = 2.0;
  const d = 2.0;
  g.add(rbox(w, 3.3, d, 0.14, mat(wall), 0, 1.65, 0), rbox(w + 0.2, 0.16, d + 0.2, 0.06, mat(PALETTE.stone), 0, 0.08, 0));
  g.add(rbox(w + 0.3, 0.18, d + 0.3, 0.06, mat(PALETTE.stone), 0, 1.78, 0)); // a band between the floors
  const roofM = mat(roof, { rough: 0.7 });
  g.add(rbox(w + 0.3, 0.3, d + 0.3, 0.1, roofM, 0, 3.4, 0));
  const dorm = gable(0.9, 0.55, 0.9, roofM);
  dorm.position.set(0, 3.55, 0.35);
  g.add(dorm, rbox(0.6, 0.45, 0.2, 0.05, mat(wall), 0, 3.6, 0.35));
  doorAt(g, 0, d / 2, 0.6, 1.1);
  lampAt(g, -0.55, 1.1, d / 2 + 0.08);
  windowAt(g, glass, -0.5, 0.95, d / 2, 0.42, 0.55, false);
  windowAt(g, glass, 0.5, 2.5, d / 2, 0.42, 0.55, true);
  windowAt(g, glass, -0.5, 2.5, d / 2, 0.42, 0.55, true);
  g.add(rbox(1.5, 0.08, 0.5, 0.03, mat(PALETTE.woodDark), 0, 1.9, d / 2 + 0.25)); // a little balcony
  for (const x of [-0.7, -0.35, 0, 0.35, 0.7]) g.add(rbox(0.04, 0.3, 0.04, 0.01, mat(PALETTE.woodDark), x, 2.07, d / 2 + 0.47));
  return { group: g, top: 4.2 };
}

function barn({ glass }) {
  const g = new THREE.Group();
  const w = 3.4;
  const d = 3.0;
  const h = 1.7;
  const red = mat("#c9574a");
  const white = mat("#fff7ea");
  g.add(rbox(w, h, d, 0.12, red, 0, h / 2, 0));
  const roofM = mat("#6b5a52", { rough: 0.7 });
  const rf = prism([[-w / 2 - 0.2, 0], [w / 2 + 0.2, 0], [w * 0.36, 0.9], [0, 1.65], [-w * 0.36, 0.9]], d + 0.4, roofM, 0.07); // a gambrel roof
  rf.position.y = h - 0.05;
  g.add(rf);
  g.add(rbox(1.3, 1.25, 0.1, 0.04, white, 0, 0.7, d / 2 + 0.02));
  for (const s of [1, -1]) {
    const brace = rbox(0.07, 1.6, 0.06, 0.02, red, 0, 0.7, d / 2 + 0.08);
    brace.rotation.z = s * 0.68;
    g.add(brace);
  }
  g.add(rbox(1.35, 0.07, 0.07, 0.02, red, 0, 0.7, d / 2 + 0.09));
  windowAt(g, glass, 0, h + 0.65, d / 2 + 0.3, 0.4, 0.4, false);
  lampAt(g, 0.95, 1.2, d / 2 + 0.08);
  g.add(rbox(0.5, 0.5, 0.5, 0.05, mat(PALETTE.wood), 1.9, 0.25, d / 2 + 0.1), cyl(0.2, 0.2, 0.5, mat("#e9d27a"), -1.9, 0.25, d / 2 + 0.2, 12)); // a crate and a hay bale
  return { group: g, top: 3.4 };
}

function aframe({ glass, roof }) {
  const g = new THREE.Group();
  const w = 2.6;
  const d = 2.4;
  const wood = mat("#d9a06b");
  const body = prism([[-w / 2, 0], [w / 2, 0], [0, 2.9]], d, mat(roof, { rough: 0.7 }), 0.07);
  g.add(body);
  const front = prism([[-w / 2 + 0.35, 0], [w / 2 - 0.35, 0], [0, 2.3]], 0.1, wood, 0.03);
  front.position.z = d / 2 + 0.04;
  g.add(front);
  const pane = prism([[-0.55, 0.2], [0.55, 0.2], [0, 1.5]], 0.08, glass, 0.02);
  pane.position.z = d / 2 + 0.12;
  pane.userData.keep = true;
  g.add(pane);
  g.add(rbox(w + 0.4, 0.1, 0.9, 0.04, mat(PALETTE.woodDark), 0, 0.05, d / 2 + 0.55)); // a deck
  g.add(rbox(0.5, 0.35, 0.5, 0.05, mat(PALETTE.wood), 0.8, 0.27, d / 2 + 0.6));
  doorAt(g, 0.65, d / 2 + 0.05, 0.4, 0.85);
  lampAt(g, -0.6, 1.1, d / 2 + 0.1);
  return { group: g, top: 3.0 };
}

// a stilt house in the style of the old river houses of Bangkok: teak on posts, steep roof
function thai({ glass }) {
  const g = new THREE.Group();
  const teak = mat("#b9794a");
  const roofM = mat("#b5483a", { rough: 0.6 });
  const gold = mat("#ffcf4a", { metal: 0.5, rough: 0.4 });
  const lift = 0.85;
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) g.add(cyl(0.08, 0.1, lift + 0.1, mat(PALETTE.woodDark), x, lift / 2, z, 8));
  g.add(rbox(2.7, 0.12, 2.7, 0.04, mat(PALETTE.wood), 0, lift, 0));
  g.add(rbox(2.2, 1.35, 2.2, 0.1, teak, 0, lift + 0.7, 0));
  const rf = gable(3.3, 1.6, 3.2, roofM);
  rf.position.y = lift + 1.3;
  g.add(rf);
  for (const s of [-1, 1]) { // the upswept ends of the ridge
    const horn = cone(0.07, 0.65, gold, 0, lift + 3.05, s * 1.5, 8);
    horn.rotation.x = s * -0.7;
    g.add(horn);
  }
  doorAt(g, 0, 1.1, 0.55, 1.0);
  g.children.at(-3).position.y += lift; // doorAt puts the door at ground level: lift it onto the porch
  g.children.at(-2).position.y += lift;
  g.children.at(-1).position.y += lift;
  windowAt(g, glass, -0.7, lift + 0.8, 1.1, 0.4, 0.45, false);
  windowAt(g, glass, 0.7, lift + 0.8, 1.1, 0.4, 0.45, false);
  for (let i = 0; i < 4; i++) g.add(rbox(0.9, 0.06, 0.26, 0.02, mat(PALETTE.wood), 0, 0.12 + i * 0.2, 1.7 + (3 - i) * 0.2)); // the stair
  lampAt(g, 1.0, lift + 1.1, 1.18);
  return { group: g, top: lift + 3.1 };
}

function greenhouse({ glass }) {
  const g = new THREE.Group();
  const w = 2.8;
  const d = 2.2;
  const pane = mat("#cfeee4", { opacity: 0.38, rough: 0.2 });
  const frame = mat("#ffffff", { rough: 0.6 });
  g.add(rbox(w, 0.4, d, 0.05, mat(PALETTE.stone, { rough: 0.95 }), 0, 0.2, 0));
  g.add(rbox(w - 0.1, 0.95, d - 0.1, 0.03, pane, 0, 0.88, 0));
  const roofShape = prism([[-w / 2, 0], [w / 2, 0], [0, 0.9]], d, pane, 0.03);
  roofShape.position.y = 1.36;
  g.add(roofShape);
  for (const x of [-w / 2, -w / 4, 0, w / 4, w / 2]) g.add(rbox(0.05, 1.0, 0.06, 0.01, frame, x, 0.9, d / 2));
  g.add(rbox(w, 0.05, 0.06, 0.01, frame, 0, 1.4, d / 2));
  const live = ["#6fbf73", "#58a862", "#ff8fa8", "#ffd45e"];
  for (let i = 0; i < 7; i++) g.add(ball(0.2 + (i % 3) * 0.06, mat(live[i % live.length]), -1 + (i % 4) * 0.66, 0.65, -0.4 + Math.floor(i / 4) * 0.7));
  const lamp = ball(0.07, glass, 0, 1.0, 0.3, 1, 1, 1, false);
  lamp.userData.keep = true;
  g.add(lamp);
  doorAt(g, 0, d / 2 + 0.02, 0.5, 0.8);
  return { group: g, top: 2.3 };
}

function warehouse({ glass, roof }) {
  const g = new THREE.Group();
  const w = 3.6;
  const d = 2.6;
  const h = 1.5;
  g.add(rbox(w, h, d, 0.1, mat("#dfe6ee"), 0, h / 2, 0));
  const rf = gable(w + 0.3, 0.55, d + 0.3, mat(roof, { rough: 0.6, metal: 0.2 }));
  rf.rotation.y = Math.PI / 2;
  rf.position.y = h - 0.02;
  g.add(rf);
  g.add(rbox(1.5, 1.2, 0.08, 0.04, mat("#9fb3c8", { metal: 0.3, rough: 0.5 }), 0, 0.62, d / 2 + 0.03));
  for (let i = 0; i < 5; i++) g.add(rbox(1.4, 0.03, 0.04, 0.01, mat("#7f93a8"), 0, 0.25 + i * 0.22, d / 2 + 0.09));
  windowAt(g, glass, -1.4, 0.95, d / 2, 0.4, 0.3, false);
  windowAt(g, glass, 1.4, 0.95, d / 2, 0.4, 0.3, false);
  for (const x of [-1.1, 0, 1.1]) g.add(cyl(0.11, 0.11, 0.3, mat("#9fb3c8", { metal: 0.4 }), x, h + 0.55, 0, 10)); // roof vents
  lampAt(g, 1.0, 1.35, d / 2 + 0.06);
  g.add(rbox(0.45, 0.45, 0.45, 0.04, mat(PALETTE.wood), -1.6, 0.23, d / 2 + 0.5), rbox(0.4, 0.4, 0.4, 0.04, mat(PALETTE.woodDark), -1.6, 0.65, d / 2 + 0.5));
  return { group: g, top: 2.3 };
}

function tank({ glass }) {
  const g = new THREE.Group();
  const steel = mat("#b8c7d6", { metal: 0.3, rough: 0.5 });
  for (const [x, z] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) g.add(cyl(0.07, 0.09, 1.2, mat(PALETTE.woodDark), x, 0.6, z, 8));
  g.add(cyl(0.9, 0.9, 1.3, steel, 0, 1.85, 0, 24), ball(0.9, steel, 0, 2.5, 0, 1, 0.55, 1));
  g.add(cyl(0.92, 0.92, 0.1, mat("#ffffff"), 0, 1.5, 0, 24), cyl(0.92, 0.92, 0.1, mat("#ffffff"), 0, 2.15, 0, 24));
  const eye = ball(0.18, glass, 0, 1.85, 0.88, 1, 1, 0.5, false);
  eye.userData.keep = true;
  g.add(eye);
  g.add(cyl(0.025, 0.025, 1.9, mat(PALETTE.woodDark), 0.95, 1.0, 0.3, 6)); // a ladder rail
  g.add(rbox(0.9, 0.08, 0.4, 0.03, mat(PALETTE.stone), 0, 0.04, 1.1));
  lampAt(g, 0, 2.95, 0);
  return { group: g, top: 3.4 };
}

function yurt({ wall, roof, glass }) {
  const g = new THREE.Group();
  g.add(cyl(1.15, 1.2, 1.1, mat(wall), 0, 0.55, 0, 24));
  g.add(cone(1.45, 1.0, mat(roof, { rough: 0.7 }), 0, 1.55, 0, 24));
  g.add(cyl(0.1, 0.1, 0.5, mat("#6b5a52"), 0.45, 2.2, -0.2, 8)); // a stove pipe
  doorAt(g, 0, 1.17, 0.5, 0.85);
  windowAt(g, glass, 0.62, 0.7, 1.0, 0.3, 0.3, false);
  lampAt(g, -0.55, 0.95, 1.12);
  g.add(ball(0.12, lampMat, 0, 2.12, 0, 1, 1, 1, false));
  return { group: g, top: 2.6 };
}

function kiosk({ wall, roof, accent, glass }) {
  const g = new THREE.Group();
  g.add(rbox(1.5, 1.25, 1.1, 0.08, mat(wall), 0, 0.62, 0));
  g.add(rbox(1.7, 0.14, 1.3, 0.05, mat(roof, { rough: 0.7 }), 0, 1.32, 0));
  windowAt(g, glass, 0, 0.82, 0.55, 0.7, 0.36, false);
  g.add(rbox(1.5, 0.08, 0.36, 0.03, mat(PALETTE.wood), 0, 0.5, 0.7)); // a counter
  awning(g, 1.4, 1.1, 0.55, accent);
  g.add(rbox(0.5, 0.24, 0.05, 0.02, mat(PALETTE.wood), 0, 1.58, 0.45), ball(0.12, mat(accent), 0, 1.78, 0.45, 1, 1, 0.3));
  lampAt(g, 0.7, 1.05, 0.58);
  return { group: g, top: 1.9 };
}

function clockTower({ roof, glass }) {
  const g = new THREE.Group();
  g.add(rbox(1.2, 3.0, 1.2, 0.1, mat("#f1e6d0"), 0, 1.5, 0), rbox(1.4, 0.2, 1.4, 0.06, mat(PALETTE.stone), 0, 0.1, 0), rbox(1.4, 0.18, 1.4, 0.06, mat(PALETTE.stone), 0, 3.05, 0));
  g.add(cone(1.0, 1.1, mat(roof, { rough: 0.7 }), 0, 3.7, 0, 4));
  g.children.at(-1).rotation.y = Math.PI / 4;
  const face = canvasTexture(128, (c, s) => {
    c.fillStyle = "#fffaf0"; c.beginPath(); c.arc(s / 2, s / 2, s / 2 - 4, 0, 7); c.fill();
    c.strokeStyle = "#5a4636"; c.lineWidth = 6; c.stroke();
    for (let i = 0; i < 12; i++) { const a = (i / 12) * 6.283; c.fillStyle = "#5a4636"; c.fillRect(s / 2 + Math.sin(a) * 46 - 3, s / 2 - Math.cos(a) * 46 - 3, 6, 6); }
    c.fillRect(s / 2 - 3, s / 2 - 34, 6, 34); c.fillRect(s / 2, s / 2 - 3, 24, 6);
  });
  const clock = shadowed(new THREE.Mesh(new THREE.CircleGeometry(0.42, 24), new THREE.MeshStandardMaterial({ map: face, roughness: 0.6 })), { cast: false });
  clock.position.set(0, 2.35, 0.62);
  clock.userData.keep = true;
  g.add(clock);
  windowAt(g, glass, 0, 1.1, 0.6, 0.3, 0.45, false);
  doorAt(g, 0, 0.6, 0.45, 0.75);
  return { group: g, top: 4.4 };
}

// a windmill whose sails turn (the sails are the one unbaked part)
function windmill({ roof, glass }) {
  const g = new THREE.Group();
  g.add(cyl(0.55, 0.95, 2.4, mat("#f6ead4"), 0, 1.2, 0, 14), cone(0.78, 0.8, mat(roof, { rough: 0.7 }), 0, 2.8, 0, 14), cyl(0.7, 0.75, 0.12, mat(PALETTE.stone), 0, 0.06, 0, 14));
  doorAt(g, 0, 0.88, 0.45, 0.8);
  windowAt(g, glass, 0, 1.5, 0.68, 0.28, 0.3, false);
  const sails = new THREE.Group();
  sails.position.set(0, 2.45, 0.85);
  for (let i = 0; i < 4; i++) {
    const arm = new THREE.Group();
    arm.rotation.z = (i * Math.PI) / 2;
    const bar = rbox(0.06, 1.7, 0.05, 0.015, mat(PALETTE.woodDark), 0, 0.9, 0);
    const cloth = rbox(0.42, 1.2, 0.03, 0.01, mat("#fffaf0"), 0.24, 1.05, 0.03);
    bar.userData.keep = cloth.userData.keep = true;
    arm.add(bar, cloth);
    sails.add(arm);
  }
  sails.add(ball(0.1, mat(PALETTE.woodDark), 0, 0, 0.02));
  sails.userData.spin = true;
  g.add(sails);
  return { group: g, top: 3.4, sails };
}

function silo({ index }) {
  const g = new THREE.Group();
  const body = pick(SILOS, index);
  const roof = pick(ROOFS, index + 2);
  g.add(cyl(0.8, 0.85, 2.1, mat(body), 0, 1.05, 0, 24), cyl(0.86, 0.86, 0.14, mat("#ffffff"), 0, 0.7, 0, 24), cyl(0.84, 0.84, 0.14, mat("#ffffff"), 0, 1.45, 0, 24));
  g.add(cone(0.98, 0.9, mat(roof, { rough: 0.7 }), 0, 2.55, 0, 24), ball(0.07, lampMat, 0, 3.05, 0, 1, 1, 1, false));
  const glass = mat("#fff4cf", { emissive: PALETTE.glass, glow: 0.3, unique: true });
  const win = shadowed(new THREE.Mesh(new THREE.CircleGeometry(0.24, 18), glass), { cast: false });
  win.position.set(0, 1.1, 0.835);
  win.userData.keep = true;
  g.add(win, rbox(0.55, 0.9, 0.12, 0.05, mat(PALETTE.woodDark), 0, 0.47, 0.83), rbox(0.6, 0.16, 0.34, 0.04, mat(PALETTE.stone), 0, 0.08, 1.0));
  return { group: g, top: 3.2, glass };
}

function lighthouse({ index }) {
  const g = new THREE.Group();
  const red = mat("#e8604f");
  const white = mat("#fff7ea");
  for (let i = 0; i < 4; i++) g.add(cyl(0.62 - i * 0.07, 0.69 - i * 0.07, 0.75, i % 2 ? white : red, 0, 0.4 + i * 0.75, 0, 16));
  const lanternMat = mat("#fff0b8", { emissive: "#ffd98a", glow: 0.9, unique: true });
  const lantern = cyl(0.42, 0.42, 0.55, lanternMat, 0, 3.75, 0, 12);
  lantern.userData.keep = true;
  g.add(cyl(0.72, 0.72, 0.1, mat(PALETTE.woodDark), 0, 3.42, 0, 16), lantern);
  g.add(cone(0.55, 0.55, mat(pick(ROOFS, index), { rough: 0.7 }), 0, 4.3, 0, 12), cyl(0.9, 1.0, 0.18, mat(PALETTE.stone), 0, 0.09, 0, 16));
  doorAt(g, 0, 0.88, 0.4, 0.7);
  return { group: g, top: 4.8, glass: lanternMat };
}

// A dwelling for an agent: a cottage with a flag of its colour on the roof.
function home({ color, free, glass }) {
  const b = cottage({ w: 3.4, d: 2.5, h: 1.9, wall: free ? "#ece7dc" : "#fff3dc", roof: free ? "#bdb5a8" : color, accent: color, shop: false, ridgeX: false, chimney: !free, glass });
  const g = b.group;
  g.add(cyl(0.025, 0.025, 0.9, mat(PALETTE.woodDark), 0, b.top + 0.35, 0, 6), rbox(0.5, 0.28, 0.03, 0.02, mat(free ? "#d9d3c7" : color), 0.27, b.top + 0.65, 0));
  g.add(rbox(1.0, 0.1, 0.4, 0.04, mat(PALETTE.wood), -1.3, 0.42, 1.65), rbox(0.08, 0.4, 0.34, 0.02, mat(PALETTE.woodDark), -1.7, 0.2, 1.65), rbox(0.08, 0.4, 0.34, 0.02, mat(PALETTE.woodDark), -0.9, 0.2, 1.65));
  g.add(cyl(0.14, 0.11, 0.24, mat("#e8a07a"), 1.45, 0.12, 1.6, 12), ball(0.2, mat(PALETTE.leaf), 1.45, 0.4, 1.6));
  return { group: g, top: b.top + 1 };
}

// What is left of a retired service: the footprint of its old style, a few broken wall stubs,
// a fallen beam, rubble and weeds. No lit windows (the glass is a dead, unlit pane).
function ruins({ node }) {
  const r = rng(hash(node) + 17);
  const g = new THREE.Group();
  const stone = [mat("#b9b3a8", { rough: 0.95, flat: true }), mat("#a39d93", { rough: 0.95, flat: true }), mat("#8f8a82", { rough: 0.95, flat: true })];
  g.add(rbox(3.2, 0.12, 2.6, 0.05, mat("#a89f8f", { rough: 1 }), 0, 0.06, 0));
  for (const [x, z, w, d] of [[-1.35, 0, 0.22, 2.2], [0.2, -1.05, 2.4, 0.22], [1.35, 0.5, 0.22, 1.1]]) {
    const h = 0.4 + r() * 1.0;
    g.add(rbox(w, h, d, 0.04, stone[Math.floor(r() * 3)], x, 0.12 + h / 2, z));
  }
  const beam = rbox(0.14, 0.14, 2.2, 0.03, mat(PALETTE.woodDark, { rough: 1 }), 0.1, 0.45, 0.2);
  beam.rotation.set(0.35, 0.5, 0.2);
  g.add(beam);
  for (let i = 0; i < 7; i++) {
    const s = 0.14 + r() * 0.22;
    const chunk = rbox(s, s * 0.7, s * 0.9, 0.03, stone[i % 3], (r() - 0.5) * 3.0, s * 0.35 + 0.1, (r() - 0.5) * 2.4);
    chunk.rotation.y = r() * Math.PI;
    g.add(chunk);
  }
  for (let i = 0; i < 4; i++) g.add(ball(0.22 + r() * 0.12, mat(i % 2 ? PALETTE.leafDark : PALETTE.leaf), (r() - 0.5) * 3.2, 0.14, (r() - 0.5) * 2.6, 1, 0.6, 1, false));
  return { group: g, top: 1.6, glass: mat("#3b3a3a", { rough: 1, unique: true }) };
}

// The building for a map node: its style decides the shape, its id the colours; `ruin` (a retired
// node) draws what is left of it instead.
export function makeBuilding({ style, node = "", index = 0, color = "#ffb547", free = false, ruin = false }) {
  if (ruin) return ruins({ node });
  const seed = hash(node);
  const wall = pick(WALLS, seed);
  const roof = pick(ROOFS, seed >> 3);
  const glass = mat("#fff4cf", { rough: 0.3, emissive: PALETTE.glass, glow: 0.3, unique: true });
  const opts = { wall, roof, accent: roof, glass, index, color, free };
  let built;
  switch (style) {
    case "home": built = home(opts); break;
    case "townhouse": built = townhouse(opts); break;
    case "shop": built = cottage({ ...opts, shop: true, ridgeX: seed % 3 === 0, chimney: seed % 2 === 0 }); break;
    case "barn": built = barn(opts); break;
    case "aframe": built = aframe(opts); break;
    case "thai": built = thai(opts); break;
    case "greenhouse": built = greenhouse(opts); break;
    case "warehouse": built = warehouse({ ...opts, roof: pick(["#7d93ab", "#8c9db0", "#a9a3c8"], seed) }); break;
    case "tank": built = tank(opts); break;
    case "yurt": built = yurt(opts); break;
    case "kiosk": built = kiosk(opts); break;
    case "clock": built = clockTower(opts); break;
    case "windmill": built = windmill(opts); break;
    case "silo": built = silo(opts); break;
    case "lighthouse": built = lighthouse(opts); break;
    default: built = cottage({ ...opts, w: 3.0, d: 2.4, h: 1.8, shop: false, ridgeX: seed % 2 === 0, chimney: seed % 3 !== 0 });
  }
  return { ...built, glass: built.glass ?? glass };
}

// ---------- scenery ----------

export function makeTree(r, kind = Math.floor(r() * 10)) {
  const g = new THREE.Group();
  const s = 0.8 + r() * 0.6;
  const greens = [PALETTE.leaf, PALETTE.leafDark, "#82cf7d", "#6bb86c"];
  const green = () => mat(pick(greens, Math.floor(r() * 99)));
  if (kind < 2) { // a pine
    g.add(cyl(0.1 * s, 0.14 * s, 0.7 * s, mat(PALETTE.trunk), 0, 0.35 * s, 0, 7));
    for (let i = 0; i < 3; i++) g.add(cone((0.75 - i * 0.17) * s, 0.9 * s, mat(i % 2 ? PALETTE.leafDark : "#4f9f5f"), 0, (1.0 + i * 0.55) * s, 0, 9));
  } else if (kind < 3) { // a palm, for Bangkok
    const lean = (r() - 0.5) * 0.5;
    for (let i = 0; i < 5; i++) g.add(cyl(0.09 * s, 0.12 * s, 0.7 * s, mat("#b08a5c"), lean * i * 0.18, (0.35 + i * 0.62) * s, 0, 7));
    const top = { x: lean * 0.9, y: 3.2 * s };
    for (let i = 0; i < 7; i++) {
      const frond = ball(0.16, mat(i % 2 ? "#4fae63" : "#63bf70"), top.x + Math.cos((i / 7) * 6.28) * 0.5 * s, top.y - 0.1, Math.sin((i / 7) * 6.28) * 0.5 * s, 3.2 * s, 0.22, 0.9);
      frond.rotation.y = -(i / 7) * 6.28;
      frond.rotation.z = -0.35;
      g.add(frond);
    }
    g.add(ball(0.13, mat("#7a5a3a"), top.x, top.y - 0.15, 0));
  } else if (kind < 4) { // a tall slim tree
    g.add(cyl(0.08 * s, 0.12 * s, 1.2 * s, mat("#d7cfc0"), 0, 0.6 * s, 0, 7), ball(0.5 * s, green(), 0, 1.7 * s, 0, 0.8, 1.5, 0.8), ball(0.35 * s, green(), 0.15 * s, 1.3 * s, 0.1));
  } else { // a round tree
    g.add(cyl(0.12 * s, 0.17 * s, 0.9 * s, mat(PALETTE.trunk), 0, 0.45 * s, 0, 8), ball(0.62 * s, green(), 0, 1.35 * s, 0), ball(0.42 * s, green(), 0.38 * s, 1.0 * s, 0.15 * s), ball(0.38 * s, green(), -0.34 * s, 1.1 * s, -0.12 * s));
  }
  g.rotation.y = r() * 6.28;
  return g;
}

export function makeBush(r) {
  const g = new THREE.Group();
  const m = mat(r() < 0.5 ? PALETTE.leaf : PALETTE.leafDark);
  const s = 0.5 + r() * 0.5;
  g.add(ball(0.4 * s, m, 0, 0.3 * s, 0), ball(0.3 * s, m, 0.35 * s, 0.22 * s, 0.1 * s), ball(0.28 * s, m, -0.3 * s, 0.2 * s, -0.1 * s));
  if (r() < 0.4) for (let i = 0; i < 4; i++) g.add(ball(0.06, mat(pick(["#ff8fa8", "#ffd45e", "#ffffff"], Math.floor(r() * 9))), (r() - 0.5) * 0.7 * s, 0.4 * s + r() * 0.2, 0.3 * s, 1, 1, 1, false));
  return g;
}

export function makeRock(r) {
  const m = shadowed(new THREE.Mesh(new THREE.IcosahedronGeometry(0.4 + r() * 0.5, 0), mat(pick(["#a9a79f", "#b9b6ab", "#9c9a93"], Math.floor(r() * 9)), { flat: true })));
  m.scale.set(1, 0.6 + r() * 0.4, 0.8 + r() * 0.4);
  m.position.y = 0.15;
  m.rotation.y = r() * 6;
  return m;
}

export function makeLamp() {
  const g = new THREE.Group();
  g.add(cyl(0.045, 0.06, 1.5, mat(PALETTE.woodDark), 0, 0.75, 0, 8), ball(0.16, lampMat, 0, 1.62, 0, 1, 1, 1, false), cyl(0.01, 0.2, 0.12, mat(PALETTE.woodDark), 0, 1.86, 0, 8));
  return g;
}

export function makeBench() {
  const g = new THREE.Group();
  g.add(rbox(1.1, 0.1, 0.4, 0.04, mat(PALETTE.wood), 0, 0.42, 0), rbox(1.1, 0.35, 0.07, 0.03, mat(PALETTE.wood), 0, 0.7, -0.19), rbox(0.08, 0.4, 0.34, 0.02, mat(PALETTE.woodDark), -0.45, 0.2, 0), rbox(0.08, 0.4, 0.34, 0.02, mat(PALETTE.woodDark), 0.45, 0.2, 0));
  return g;
}

export function makeFountain() {
  const g = new THREE.Group();
  const stone = mat("#e5dfd2");
  g.add(cyl(2.0, 2.2, 0.5, stone, 0, 0.25, 0, 28), cyl(1.8, 1.8, 0.08, mat(PALETTE.water, { rough: 0.15, emissive: "#3a8fb7", glow: 0.15 }), 0, 0.5, 0, 28));
  g.add(cyl(0.3, 0.45, 1.0, stone, 0, 0.8, 0, 14), cyl(0.9, 0.9, 0.12, stone, 0, 1.3, 0, 20), ball(0.28, mat("#bfe8f5", { rough: 0.2 }), 0, 1.6, 0));
  return g;
}

// puffy cloud: a few flattened spheres
export function makeCloud(r) {
  const g = new THREE.Group();
  const body = mat("#ffffff", { rough: 1, emissive: "#ffffff", glow: 0.25, unique: true });
  const n = 4 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) g.add(ball(1.1 + r() * 0.9, body, (i - n / 2) * 1.5 + r(), r() * 0.5, r() * 1.2 - 0.6, 1, 0.62, 1, false));
  g.userData.body = body;
  return g;
}

// A bird: a round body, a beak, a tail and two wings that flap.
export function makeBird(color) {
  const g = new THREE.Group();
  const body = mat(color, { rough: 0.7 });
  g.add(ball(0.2, body, 0, 0, 0, 0.9, 0.8, 1.4, false), ball(0.13, body, 0, 0.07, 0.26, 1, 1, 1, false), cone(0.04, 0.14, mat("#ffb347"), 0, 0.05, 0.4, 5), ball(0.05, mat("#2b2230"), 0.07, 0.1, 0.34, 1, 1, 1, false), ball(0.05, mat("#2b2230"), -0.07, 0.1, 0.34, 1, 1, 1, false));
  g.children.at(-3).rotation.x = Math.PI / 2;
  g.add(ball(0.1, body, 0, 0, -0.3, 0.6, 0.3, 1.6, false));
  const wings = [-1, 1].map((s) => {
    const pivot = new THREE.Group();
    pivot.position.set(s * 0.12, 0.05, 0);
    pivot.add(ball(0.24, mat(color, { rough: 0.7 }), s * 0.22, 0, 0, 1.1, 0.12, 0.7, false));
    g.add(pivot);
    return pivot;
  });
  g.userData.wings = wings;
  return g;
}

// ---------- characters ----------

// A chibi character: a big round head with a face, a small round body, little feet — and an
// accessory that tells the agents apart. Colour is the agent's, softened.
export function makeAvatar(agent) {
  const g = new THREE.Group();
  const mats = [];
  const track = (m) => (mats.push(m), m);
  const own = (c, o) => track(mat(c, { ...o, unique: true }));
  const color = new THREE.Color(agent.color).lerp(new THREE.Color("#ffffff"), 0.12);
  const skin = own(color, { rough: 0.6 });
  const light = own(color.clone().lerp(new THREE.Color("#ffffff"), 0.55), { rough: 0.6 });
  const ink = own("#2b2230", { rough: 0.4 });
  const white = own("#ffffff", { rough: 0.5 });
  const blush = own("#ff9fb4", { rough: 0.9 });
  const dark = own(color.clone().multiplyScalar(0.55), { rough: 0.7 });
  const part = (m) => { m.userData.keep = true; return m; };

  const body = new THREE.Group();
  body.position.y = 0.55;
  body.add(part(ball(0.3, skin, 0, 0, 0, 1, 1.05, 0.9)), part(ball(0.2, light, 0, -0.04, 0.17, 1, 1.2, 0.5, false)));
  g.add(body);
  const head = new THREE.Group();
  head.position.y = 1.1;
  head.add(part(ball(0.4, skin, 0, 0, 0, 1.04, 0.96, 1)));
  for (const s of [-1, 1]) {
    head.add(part(ball(0.052, ink, s * 0.15, 0.02, 0.37, 1, 1.25, 0.6, false)), part(ball(0.016, white, s * 0.15 + 0.014, 0.05, 0.4, 1, 1, 1, false)), part(ball(0.07, blush, s * 0.25, -0.09, 0.32, 1.3, 0.7, 0.4, false)));
  }
  const mouth = part(new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.011, 6, 12, Math.PI), ink));
  mouth.position.set(0, -0.07, 0.385);
  mouth.rotation.z = Math.PI;
  head.add(mouth);
  g.add(head);

  switch (agent.id) {
    case "claude-code": // a little spark of three crossed strokes on top
      for (let i = 0; i < 3; i++) {
        const ray = part(rbox(0.06, 0.3, 0.06, 0.025, white, 0, 0.5, 0));
        ray.rotation.z = (i * Math.PI) / 3;
        head.add(ray);
      }
      break;
    case "hermes": // a winged cap
      head.add(part(ball(0.36, light, 0, 0.14, 0, 1.02, 0.55, 1, false)));
      for (const s of [-1, 1]) {
        const wing = part(ball(0.1, white, s * 0.42, 0.22, 0, 0.5, 1.3, 0.4));
        wing.rotation.z = -s * 0.5;
        head.add(wing);
      }
      break;
    case "buzz": // bee: antennae and stripes
      for (const s of [-1, 1]) {
        const stalk = part(cyl(0.012, 0.012, 0.3, ink, s * 0.12, 0.5, 0, 6));
        stalk.rotation.z = -s * 0.3;
        head.add(stalk, part(ball(0.05, dark, s * 0.2, 0.66, 0, 1, 1, 1, false)));
      }
      for (const y of [-0.08, 0.1]) {
        const stripe = part(new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.035, 8, 24), ink));
        stripe.rotation.x = Math.PI / 2;
        stripe.position.y = y;
        body.add(stripe);
      }
      break;
    case "gemini": // twin buns
      for (const s of [-1, 1]) head.add(part(ball(0.15, dark, s * 0.27, 0.36, 0)));
      break;
    case "chatgpt": { // a leaf sprout
      const leafM = own("#7fd6a0");
      for (const s of [-1, 1]) {
        const leaf = part(ball(0.14, leafM, s * 0.12, 0.5, 0, 1.6, 0.6, 0.4));
        leaf.rotation.z = -s * 0.7;
        head.add(leaf);
      }
      head.add(part(cyl(0.015, 0.02, 0.18, dark, 0, 0.42, 0, 6)));
      break;
    }
  }

  const arms = [-1, 1].map((s) => {
    const pivot = new THREE.Group();
    pivot.position.set(s * 0.33, 0.7, 0.02);
    pivot.add(part(ball(0.09, skin, 0, -0.17, 0, 1, 1.9, 1)));
    g.add(pivot);
    return pivot;
  });
  const feet = [-1, 1].map((s) => {
    const foot = part(ball(0.12, dark, s * 0.15, 0.1, 0.05, 1, 0.7, 1.35));
    g.add(foot);
    return foot;
  });

  // a laptop for when it works, stars for when it is done
  const laptop = new THREE.Group();
  const silver = mat("#cfd3dc", { metal: 0.5, rough: 0.4, unique: true });
  laptop.add(part(rbox(0.5, 0.04, 0.34, 0.015, silver, 0, 0, 0)));
  const lid = part(rbox(0.5, 0.34, 0.03, 0.012, silver, 0, 0.17, -0.17));
  lid.rotation.x = -0.25;
  const screenTex = canvasTexture(128, (c, s) => {
    c.fillStyle = "#2c3350"; c.fillRect(0, 0, s, s);
    c.fillStyle = "#ff9f5a"; c.fillRect(8, 8, s - 16, 10);
    const rr = rng(5);
    for (let y = 28; y < s - 10; y += 12) { c.fillStyle = ["#9be3b4", "#8fc7ff", "#ffe08a", "#f6a6c9"][Math.floor(rr() * 4)]; c.fillRect(10 + Math.floor(rr() * 3) * 12, y, 20 + rr() * 70, 5); }
  });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.28), new THREE.MeshStandardMaterial({ color: "#ffffff", emissive: "#ffffff", emissiveMap: screenTex, emissiveIntensity: 0.9, roughness: 0.3 }));
  screen.position.set(0, 0, 0.02);
  lid.add(screen);
  laptop.add(lid);
  laptop.position.set(0, 0.82, 0.46);
  laptop.visible = false;
  g.add(laptop);
  const stars = new THREE.Group();
  const starM = mat("#ffd45e", { emissive: "#ffd45e", glow: 0.9, rough: 0.5, unique: true });
  for (let i = 0; i < 4; i++) stars.add(part(ball(0.07, starM, Math.cos((i / 4) * 6.28) * 0.6, 0, Math.sin((i / 4) * 6.28) * 0.6, 1, 1, 1, false)));
  stars.position.y = 1.75;
  stars.visible = false;
  g.add(stars);

  g.scale.setScalar(1.38);
  return { group: g, body, head, arms, feet, laptop, stars, materials: mats };
}
