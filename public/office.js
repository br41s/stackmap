// The 3D office, drawn as a cosy little village on a floating island, in the spirit of a
// cosy town-builder: soft pastel colours, rounded toy-like shapes, warm low sun with soft
// shadows, trees and flowers. Each agent has a house, each project a small shop, each hosting
// platform a silo; the agents are chibi characters who walk along the lanes to the shop a
// signal names, type on a laptop there, and say what they are doing in a speech bubble.
// Everything that decides *where* (layout, lanes, who is where) lives in office-layout.js
// (pure, tested); this file only draws it with plain three.js — procedural shapes and canvas
// textures: no models, no image files, no build step, no post-processing add-ons (they would
// need an import map, which the CSP forbids). Loaded on demand by app.js, so the map never pays
// for three.js until the office is opened. Names and bubbles are DOM cards over the canvas. The
// frame loop stops completely while the office is hidden or the tab is in the background, and
// slows down while the window is simply unfocused.
import * as THREE from "/vendor/three.module.js";
import { FOOTPRINT, OFFICE_AGENTS, createLocator, layoutOffice, officeStates, pushSignal, routeBetween, stepToward } from "./office-layout.js";

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const WALK_SPEED = 3; // metres per second
const BLUR_FPS = 12;  // frame rate while the window is unfocused but still visible; 0 pauses it
const DEFAULT_AZIMUTH = Math.PI / 4;
const DEFAULT_ELEVATION = 0.62;
const SELECT_COLOR = "#ff7a59";

const PALETTE = {
  grass: "#9fd682", soil: "#b98b62", soilDark: "#9a7050", sand: "#f2e0b8", wood: "#c8915a", woodDark: "#8f633c",
  stone: "#d9d3c7", cream: "#fff3dc", leaf: "#6fbf73", leafDark: "#58a862", trunk: "#a1714a", glass: "#ffe6a8",
};
const WALLS = ["#fff1da", "#ffe6c9", "#f7ead4", "#eaf3df", "#fde4ea", "#e4eefb"];
const ROOFS = ["#e8795f", "#f2b34c", "#6fb7c9", "#c98bd1", "#7fc47e", "#e98fa6", "#8a9be0"];
const SILOS = ["#a9d6f5", "#bfe8cf", "#d8c7f0", "#ffd7b0"];

const hash = (str) => [...str].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7);
const pick = (list, seed) => list[seed % list.length];
function rng(seed) { // a small seeded generator: the same village every time
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- materials, geometry, textures ----------

const mat = (color, { rough = 0.85, metal = 0, emissive = null, glow = 1 } = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, emissive: emissive ?? 0x000000, emissiveIntensity: emissive ? glow : 0 });

function shadowed(mesh, { cast = true, receive = true } = {}) {
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  return mesh;
}
// A box with rounded edges and corners: an extruded rectangle whose bevel is the rounding.
function rbox(w, h, d, r, material, x = 0, y = 0, z = 0) {
  const k = Math.max(0.005, Math.min(r, w / 2 - 0.005, h / 2 - 0.005, d / 2 - 0.005));
  const shape = new THREE.Shape();
  shape.moveTo(-(w / 2 - k), -(h / 2 - k));
  shape.lineTo(w / 2 - k, -(h / 2 - k));
  shape.lineTo(w / 2 - k, h / 2 - k);
  shape.lineTo(-(w / 2 - k), h / 2 - k);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(d - 2 * k, 0.001), bevelEnabled: true, bevelThickness: k, bevelSize: k, bevelSegments: 3, curveSegments: 1 });
  g.translate(0, 0, -(d - 2 * k) / 2);
  const m = shadowed(new THREE.Mesh(g, material));
  m.position.set(x, y, z);
  return m;
}
function sphere(r, material, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, cast = true) {
  const m = shadowed(new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), material), { cast });
  m.position.set(x, y, z);
  m.scale.set(sx, sy, sz);
  return m;
}
function cylinder(rt, rb, h, material, x = 0, y = 0, z = 0, seg = 24) {
  const m = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), material));
  m.position.set(x, y, z);
  return m;
}
// A rounded slab of land seen from above: the shape of an island, extruded up.
function slabGeometry(w, d, radius, thickness) {
  const r = Math.min(radius, w / 2, d / 2);
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -d / 2);
  s.lineTo(w / 2 - r, -d / 2);
  s.quadraticCurveTo(w / 2, -d / 2, w / 2, -d / 2 + r);
  s.lineTo(w / 2, d / 2 - r);
  s.quadraticCurveTo(w / 2, d / 2, w / 2 - r, d / 2);
  s.lineTo(-w / 2 + r, d / 2);
  s.quadraticCurveTo(-w / 2, d / 2, -w / 2, d / 2 - r);
  s.lineTo(-w / 2, -d / 2 + r);
  s.quadraticCurveTo(-w / 2, -d / 2, -w / 2 + r, -d / 2);
  const g = new THREE.ExtrudeGeometry(s, { depth: thickness, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.12, bevelSegments: 3, curveSegments: 10 });
  g.rotateX(-Math.PI / 2); // shape y → -z (north), extrusion → up
  return g;
}
// A gable roof: a triangle extruded along the ridge, with soft edges.
function roofMesh(w, rise, d, material) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(w / 2, 0);
  s.lineTo(0, rise);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.07, bevelSegments: 2, curveSegments: 1 });
  g.translate(0, 0, -d / 2);
  return shadowed(new THREE.Mesh(g, material));
}

function canvasTexture(size, draw, { repeat = false } = {}) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d"), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
const grassTexture = () => canvasTexture(256, (g, s) => {
  g.fillStyle = PALETTE.grass;
  g.fillRect(0, 0, s, s);
  const r = rng(11);
  for (let i = 0; i < 46; i++) { // soft mottling, wrapped so the tile repeats without seams
    const x = r() * s, y = r() * s, rad = 14 + r() * 30;
    g.fillStyle = r() < 0.5 ? "rgba(122,190,100,0.35)" : "rgba(190,232,140,0.28)";
    for (const [ox, oy] of [[0, 0], [s, 0], [-s, 0], [0, s], [0, -s]]) { g.beginPath(); g.arc(x + ox, y + oy, rad, 0, 7); g.fill(); }
  }
  g.strokeStyle = "rgba(90,160,80,0.4)";
  g.lineWidth = 2;
  for (let i = 0; i < 90; i++) {
    const x = r() * s, y = r() * s;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 6, y - 5 - r() * 6); g.stroke();
  }
}, { repeat: true });
const dotTexture = () => canvasTexture(64, (g, s) => {
  const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.5, "rgba(255,255,255,0.55)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, s, s);
});
// What a laptop shows: a title bar and rows of text.
const screenTexture = () => canvasTexture(128, (g, s) => {
  g.fillStyle = "#2c3350";
  g.fillRect(0, 0, s, s);
  g.fillStyle = "#ff9f5a";
  g.fillRect(8, 8, s - 16, 10);
  const r = rng(5);
  for (let y = 28; y < s - 10; y += 12) {
    g.fillStyle = ["#9be3b4", "#8fc7ff", "#ffe08a", "#f6a6c9"][Math.floor(r() * 4)];
    g.fillRect(10 + Math.floor(r() * 3) * 12, y, 20 + r() * 70, 5);
  }
});

// A bright sky to reflect, baked once into an environment map (never drawn itself).
function makeEnvironment(renderer) {
  const env = new THREE.Scene();
  env.add(new THREE.Mesh(new THREE.SphereGeometry(40, 32, 16), new THREE.MeshBasicMaterial({
    side: THREE.BackSide,
    map: canvasTexture(64, (g, s) => {
      const v = g.createLinearGradient(0, 0, 0, s);
      v.addColorStop(0, "#8ec9f0");
      v.addColorStop(0.55, "#e9f3f8");
      v.addColorStop(1, "#f6d9b4");
      g.fillStyle = v;
      g.fillRect(0, 0, s, s);
    }),
  })));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(env, 0.04).texture;
  pmrem.dispose();
  return texture;
}

// ---------- buildings ----------

// A cottage or a shop: rounded walls, a gable roof, a door, glowing windows with flower boxes.
// Its windows have a material of their own so they can light up while someone works inside.
function makeBuilding({ w, d, h, wall, roof, accent, shop, ridgeX, chimney }) {
  const g = new THREE.Group();
  const wallM = mat(wall);
  const roofM = mat(roof, { rough: 0.7 });
  const wood = mat(PALETTE.wood, { rough: 0.8 });
  const woodDark = mat(PALETTE.woodDark, { rough: 0.8 });
  const glass = mat("#fff4cf", { rough: 0.3, emissive: PALETTE.glass, glow: 0.35 });
  g.add(rbox(w, h, d, 0.16, wallM, 0, h / 2, 0));
  g.add(rbox(w + 0.15, 0.16, d + 0.15, 0.06, mat(PALETTE.stone, { rough: 0.95 }), 0, 0.08, 0)); // foundation
  const rise = Math.min(1.1, w * 0.3);
  const rf = ridgeX ? roofMesh(d + 0.55, rise, w + 0.55, roofM) : roofMesh(w + 0.55, rise, d + 0.55, roofM);
  if (ridgeX) rf.rotation.y = Math.PI / 2;
  rf.position.y = h - 0.02;
  g.add(rf);
  if (chimney) {
    g.add(rbox(0.34, 0.8, 0.34, 0.05, mat("#c9694f", { rough: 0.9 }), w / 2 - 0.55, h + rise * 0.55, -d / 4));
    g.add(rbox(0.42, 0.08, 0.42, 0.03, mat(PALETTE.stone), w / 2 - 0.55, h + rise * 0.55 + 0.42, -d / 4));
  }
  const front = d / 2;
  // door, step and a little lamp beside it
  g.add(rbox(0.62, 1.15, 0.12, 0.05, woodDark, 0, 0.62, front + 0.02));
  g.add(sphere(0.045, mat("#ffd45e", { metal: 0.6, rough: 0.4 }), 0.18, 0.6, front + 0.1));
  g.add(rbox(0.95, 0.09, 0.42, 0.04, mat(PALETTE.stone, { rough: 0.95 }), 0, 0.06, front + 0.2));
  g.add(sphere(0.09, mat("#fff0b8", { emissive: "#ffd98a", glow: 1.4 }), -0.55, 1.05, front + 0.08, 1, 1, 1, false));
  // windows with frames and flower boxes
  const sides = w > 2.6 ? [-1, 1] : [1];
  for (const s of sides) {
    const wx = s * (w / 2 - 0.62);
    g.add(rbox(0.74, 0.74, 0.08, 0.06, wood, wx, h * 0.58, front + 0.0));
    g.add(rbox(0.56, 0.56, 0.08, 0.05, glass, wx, h * 0.58, front + 0.04));
    g.add(rbox(0.05, 0.56, 0.1, 0.01, wood, wx, h * 0.58, front + 0.07), rbox(0.56, 0.05, 0.1, 0.01, wood, wx, h * 0.58, front + 0.07));
    g.add(rbox(0.7, 0.15, 0.22, 0.04, wood, wx, h * 0.58 - 0.46, front + 0.12));
    for (const k of [-0.2, 0, 0.2]) g.add(sphere(0.08, mat(pick(["#ff8fa8", "#ffd45e", "#ffffff", "#c98bd1"], hash(`${wx}${k}`))), wx + k, h * 0.58 - 0.34, front + 0.14, 1, 1, 1, false));
  }
  if (shop) { // a striped awning over the front
    const slats = 6;
    for (let i = 0; i < slats; i++) {
      const sw = (w - 0.3) / slats;
      const slat = rbox(sw * 0.96, 0.06, 0.62, 0.03, mat(i % 2 ? "#ffffff" : accent, { rough: 0.8 }), -(w - 0.3) / 2 + sw * (i + 0.5), h * 0.86, front + 0.3);
      slat.rotation.x = 0.4;
      g.add(slat);
    }
  }
  return { group: g, glass, top: h + rise };
}

// An agent's house: cream walls, a roof in the agent's colour, a pennant on the roof.
function makeHome(def) {
  const free = def.reserved;
  const b = makeBuilding({ w: 3.4, d: 2.5, h: 1.9, wall: free ? "#ece7dc" : "#fff3dc", roof: free ? "#bdb5a8" : def.color, accent: def.color, shop: false, ridgeX: false, chimney: !free });
  const g = b.group;
  const pole = cylinder(0.025, 0.025, 0.9, mat(PALETTE.woodDark), 0, b.top + 0.35, 0, 6);
  const flag = rbox(0.5, 0.28, 0.03, 0.02, mat(free ? "#d9d3c7" : def.color), 0.27, b.top + 0.65, 0);
  g.add(pole, flag);
  // a bench and a plant by the door
  g.add(rbox(1.0, 0.1, 0.4, 0.04, mat(PALETTE.wood), -1.3, 0.42, 1.55), rbox(0.08, 0.4, 0.34, 0.02, mat(PALETTE.woodDark), -1.7, 0.2, 1.55), rbox(0.08, 0.4, 0.34, 0.02, mat(PALETTE.woodDark), -0.9, 0.2, 1.55));
  g.add(cylinder(0.14, 0.11, 0.24, mat("#e8a07a"), 1.45, 0.12, 1.5, 12), sphere(0.2, mat(PALETTE.leaf), 1.45, 0.4, 1.5));
  return { group: g, glass: b.glass, top: b.top + 1 };
}

function makeShop(node, i) {
  const seed = hash(node);
  const wall = pick(WALLS, seed);
  const roof = pick(ROOFS, seed >> 3);
  const b = makeBuilding({ w: 3.0, d: 2.1, h: 1.7, wall, roof, accent: roof, shop: true, ridgeX: seed % 3 === 0, chimney: seed % 2 === 0 });
  const g = b.group;
  const v = i % 3;
  const wood = mat(PALETTE.wood);
  if (v === 0) { // barrels
    g.add(cylinder(0.2, 0.2, 0.42, wood, 1.25, 0.21, 1.45, 14), cylinder(0.17, 0.17, 0.36, wood, 1.62, 0.18, 1.35, 14));
  } else if (v === 1) { // crates
    g.add(rbox(0.42, 0.38, 0.42, 0.04, wood, 1.3, 0.19, 1.45), rbox(0.34, 0.3, 0.34, 0.04, mat(PALETTE.woodDark), 1.32, 0.53, 1.45));
  } else { // a potted tree
    g.add(cylinder(0.17, 0.13, 0.3, mat("#e8a07a"), 1.35, 0.15, 1.45, 12), sphere(0.3, mat(PALETTE.leafDark), 1.35, 0.55, 1.45));
  }
  return { group: g, glass: b.glass, top: b.top + 0.6 };
}

// A server silo: a pastel tower with a stripe, a round window and a cone roof.
function makeSilo(index) {
  const g = new THREE.Group();
  const body = pick(SILOS, index);
  const roof = pick(ROOFS, index + 2);
  g.add(cylinder(0.8, 0.85, 2.1, mat(body), 0, 1.05, 0, 28));
  g.add(cylinder(0.86, 0.86, 0.14, mat("#ffffff", { rough: 0.8 }), 0, 0.7, 0, 28), cylinder(0.84, 0.84, 0.14, mat("#ffffff", { rough: 0.8 }), 0, 1.45, 0, 28));
  const cone = shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.98, 0.9, 28), mat(roof, { rough: 0.7 })));
  cone.position.y = 2.55;
  g.add(cone, sphere(0.07, mat("#fff0b8", { emissive: "#ffd98a", glow: 1.2 }), 0, 3.05, 0, 1, 1, 1, false));
  const glass = mat("#fff4cf", { rough: 0.3, emissive: PALETTE.glass, glow: 0.35 });
  const win = shadowed(new THREE.Mesh(new THREE.CircleGeometry(0.24, 20), glass), { cast: false });
  win.position.set(0, 1.1, 0.835);
  g.add(win, rbox(0.55, 0.9, 0.12, 0.05, mat(PALETTE.woodDark), 0, 0.47, 0.83));
  g.add(rbox(0.6, 0.16, 0.34, 0.04, mat(PALETTE.stone), 0, 0.08, 1.0));
  return { group: g, glass, top: 3.2 };
}

// ---------- scenery ----------

function makeTree(r) {
  const g = new THREE.Group();
  const s = 0.8 + r() * 0.5;
  g.add(cylinder(0.12 * s, 0.17 * s, 0.9 * s, mat(PALETTE.trunk), 0, 0.45 * s, 0, 8));
  const greens = [PALETTE.leaf, PALETTE.leafDark, "#82cf7d"];
  const pine = r() < 0.3;
  if (pine) {
    for (let i = 0; i < 3; i++) {
      const cone = shadowed(new THREE.Mesh(new THREE.ConeGeometry((0.7 - i * 0.15) * s, 0.8 * s, 10), mat(i % 2 ? PALETTE.leafDark : PALETTE.leaf)));
      cone.position.y = (1.1 + i * 0.5) * s;
      g.add(cone);
    }
  } else {
    g.add(sphere(0.62 * s, mat(pick(greens, Math.floor(r() * 9))), 0, 1.35 * s, 0), sphere(0.42 * s, mat(pick(greens, Math.floor(r() * 9))), 0.38 * s, 1.0 * s, 0.15 * s), sphere(0.38 * s, mat(pick(greens, Math.floor(r() * 9))), -0.34 * s, 1.1 * s, -0.12 * s));
  }
  g.rotation.y = r() * 6.28;
  return g;
}

function makeLamp() {
  const g = new THREE.Group();
  g.add(cylinder(0.045, 0.06, 1.5, mat(PALETTE.woodDark), 0, 0.75, 0, 8));
  g.add(sphere(0.16, mat("#fff0b8", { emissive: "#ffd98a", glow: 1.5 }), 0, 1.62, 0, 1, 1, 1, false));
  g.add(cylinder(0.01, 0.2, 0.12, mat(PALETTE.woodDark), 0, 1.86, 0, 8));
  return g;
}

function makeCloud(r) {
  const g = new THREE.Group();
  const m = mat("#ffffff", { rough: 1, emissive: "#ffffff", glow: 0.25 });
  const n = 4 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) g.add(sphere(1.1 + r() * 0.9, m, (i - n / 2) * 1.5 + r(), r() * 0.5, r() * 1.2 - 0.6, 1, 0.62, 1, false));
  return g;
}

// ---------- characters ----------

// A chibi character: a big round head with a face, a small round body, little feet — and an
// accessory that tells the agents apart. Colour is the agent's, softened.
function makeAvatar(agent) {
  const g = new THREE.Group();
  const mats = [];
  const track = (m) => (mats.push(m), m);
  const color = new THREE.Color(agent.color).lerp(new THREE.Color("#ffffff"), 0.12);
  const skin = track(mat(color, { rough: 0.6 }));
  const light = track(mat(color.clone().lerp(new THREE.Color("#ffffff"), 0.55), { rough: 0.6 }));
  const ink = track(mat("#2b2230", { rough: 0.4 }));
  const white = track(mat("#ffffff", { rough: 0.5 }));
  const blush = track(mat("#ff9fb4", { rough: 0.9 }));
  const dark = track(mat(color.clone().multiplyScalar(0.55), { rough: 0.7 }));

  const body = new THREE.Group();
  body.position.y = 0.55;
  body.add(sphere(0.3, skin, 0, 0, 0, 1, 1.05, 0.9), sphere(0.2, light, 0, -0.04, 0.17, 1, 1.2, 0.5, false)); // round body and a light belly
  g.add(body);
  const head = new THREE.Group();
  head.position.y = 1.1;
  head.add(sphere(0.4, skin, 0, 0, 0, 1.04, 0.96, 1));
  for (const s of [-1, 1]) {
    head.add(sphere(0.052, ink, s * 0.15, 0.02, 0.37, 1, 1.25, 0.6, false), sphere(0.016, white, s * 0.15 + 0.014, 0.05, 0.4, 1, 1, 1, false)); // eye and its glint
    head.add(sphere(0.07, blush, s * 0.25, -0.09, 0.32, 1.3, 0.7, 0.4, false)); // cheek
  }
  const mouth = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.011, 6, 12, Math.PI), ink);
  mouth.position.set(0, -0.07, 0.385);
  mouth.rotation.z = Math.PI;
  head.add(mouth);
  g.add(head);

  switch (agent.id) {
    case "claude-code": // a little spark of three crossed strokes on top
      for (let i = 0; i < 3; i++) {
        const ray = rbox(0.06, 0.3, 0.06, 0.025, white, 0, 0.5, 0);
        ray.rotation.z = (i * Math.PI) / 3;
        head.add(ray);
      }
      break;
    case "hermes": // a winged cap
      head.add(sphere(0.36, light, 0, 0.14, 0, 1.02, 0.55, 1, false));
      for (const s of [-1, 1]) {
        const wing = sphere(0.1, white, s * 0.42, 0.22, 0, 0.5, 1.3, 0.4);
        wing.rotation.z = -s * 0.5;
        head.add(wing);
      }
      break;
    case "buzz": // bee: antennae and stripes
      for (const s of [-1, 1]) {
        const stalk = cylinder(0.012, 0.012, 0.3, ink, s * 0.12, 0.5, 0, 6);
        stalk.rotation.z = -s * 0.3;
        head.add(stalk, sphere(0.05, dark, s * 0.2, 0.66, 0, 1, 1, 1, false));
      }
      for (const y of [-0.08, 0.1]) {
        const stripe = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.035, 8, 24), ink);
        stripe.rotation.x = Math.PI / 2;
        stripe.position.y = y;
        body.add(stripe);
      }
      break;
    case "gemini": // twin buns
      for (const s of [-1, 1]) head.add(sphere(0.15, dark, s * 0.27, 0.36, 0));
      break;
    case "chatgpt": // a leaf sprout
      for (const s of [-1, 1]) {
        const leaf = sphere(0.14, track(mat("#7fd6a0")), s * 0.12, 0.5, 0, 1.6, 0.6, 0.4);
        leaf.rotation.z = -s * 0.7;
        head.add(leaf);
      }
      head.add(cylinder(0.015, 0.02, 0.18, dark, 0, 0.42, 0, 6));
      break;
  }

  const arms = [-1, 1].map((s) => {
    const pivot = new THREE.Group();
    pivot.position.set(s * 0.33, 0.7, 0.02);
    const arm = sphere(0.09, skin, 0, -0.17, 0, 1, 1.9, 1);
    pivot.add(arm);
    g.add(pivot);
    return pivot;
  });
  const feet = [-1, 1].map((s) => {
    const foot = sphere(0.12, dark, s * 0.15, 0.1, 0.05, 1, 0.7, 1.35);
    g.add(foot);
    return foot;
  });

  // a laptop for when it works, stars for when it is done
  const laptop = new THREE.Group();
  laptop.add(rbox(0.5, 0.04, 0.34, 0.015, mat("#cfd3dc", { metal: 0.5, rough: 0.4 }), 0, 0, 0));
  const lid = rbox(0.5, 0.34, 0.03, 0.012, mat("#cfd3dc", { metal: 0.5, rough: 0.4 }), 0, 0.17, -0.17);
  lid.rotation.x = -0.25;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.28), new THREE.MeshStandardMaterial({ color: "#ffffff", emissive: "#ffffff", emissiveMap: screenTexture(), emissiveIntensity: 0.9, roughness: 0.3 }));
  screen.position.set(0, 0, 0.02);
  lid.add(screen);
  laptop.add(lid);
  laptop.position.set(0, 0.82, 0.46);
  laptop.visible = false;
  g.add(laptop);
  const stars = new THREE.Group();
  const star = mat("#ffd45e", { emissive: "#ffd45e", glow: 0.9, rough: 0.5 });
  for (let i = 0; i < 4; i++) {
    const s = sphere(0.07, star, Math.cos((i / 4) * 6.28) * 0.6, 0, Math.sin((i / 4) * 6.28) * 0.6, 1, 1, 1, false);
    stars.add(s);
  }
  stars.position.y = 1.75;
  stars.visible = false;
  g.add(stars);

  g.scale.setScalar(1.38);
  return { group: g, body, head, arms, feet, laptop, stars, materials: mats };
}

// ---------- the village ----------

export function createOffice(container, { stack, signals = [], hold, onPick = () => {} }) {
  const layout = layoutOffice(stack);
  const locator = createLocator(stack, layout);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // three 0.187 removed PCFSoftShadowMap: this one is soft now
  renderer.domElement.className = "office-canvas";
  container.append(renderer.domElement);
  const labels = document.createElement("div");
  labels.className = "office-labels";
  const hint = document.createElement("div");
  hint.className = "office-hint";
  const hintText = document.createElement("span");
  hintText.textContent = "drag: rotate · right-drag: pan · wheel: zoom · click a house, shop or silo";
  const demoButton = document.createElement("button");
  demoButton.type = "button";
  demoButton.textContent = "▶ Demo";
  demoButton.title = "Play a few made-up signals to see the agents work (nothing is sent anywhere)";
  hint.append(hintText, demoButton);
  container.append(labels, hint);

  const scene = new THREE.Scene();
  scene.environment = makeEnvironment(renderer);
  scene.environmentIntensity = 0.5;

  const { minX, maxX, minZ, maxZ } = layout.bounds;
  const width = maxX - minX;
  const depth = maxZ - minZ;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;

  // ---- light: a warm low sun with soft shadows, a bright sky, a little fill ----
  scene.add(new THREE.HemisphereLight(0xcfe6ff, 0xf3dcb5, 0.95));
  scene.add(new THREE.AmbientLight(0xfff0e0, 0.35));
  const sun = new THREE.DirectionalLight(0xfff0d2, 2.1);
  sun.position.set(cx - 20, 24, cz + 12);
  sun.target.position.set(cx, 0, cz);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const reach = Math.max(width, depth) * 0.66;
  Object.assign(sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 1, far: 100 });
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.035;
  scene.add(sun, sun.target);

  // ---- the island: grass on top, layers of earth below, clouds around it ----
  const island = new THREE.Group();
  const grass = grassTexture();
  grass.repeat.set(1 / 7, 1 / 7);
  const grassM = mat("#ffffff", { rough: 0.95 });
  grassM.map = grass;
  const soilM = mat(PALETTE.soil, { rough: 1 });
  const top = new THREE.Mesh(slabGeometry(width, depth, 3.4, 0.7), [grassM, soilM]);
  top.position.set(cx, -0.82, cz); // the bevel lifts the grass 0.12 above the slab: ground level is y = 0
  top.receiveShadow = true;
  island.add(top);
  [[0.86, 0.9], [0.66, 0.9], [0.42, 0.8]].forEach(([k, thick], i) => {
    const layer = new THREE.Mesh(slabGeometry(width * k, depth * k, 3, thick), [mat(PALETTE.soilDark, { rough: 1 }), mat(i % 2 ? "#a77b56" : PALETTE.soil, { rough: 1 })]);
    layer.position.set(cx, -0.82 - 0.85 * (i + 1), cz);
    layer.castShadow = true;
    island.add(layer);
  });
  scene.add(island);

  // ---- paths: the lanes and corridors the characters walk on ----
  const { lanes } = layout;
  const pathM = mat(PALETTE.sand, { rough: 1 });
  const strip = (w, d, x, z) => island.add(shadowed(rbox(w, 0.06, d, 0.025, pathM, x, 0.03, z), { cast: false }));
  const lastProjectLane = lanes.z.at(-2) ?? lanes.z[0];
  const span = lanes.outer;
  for (const z of lanes.z) strip(span * 2, 1.5, 0, z);
  for (const x of lanes.corridors) strip(1.3, lastProjectLane - lanes.z[0], x, (lanes.z[0] + lastProjectLane) / 2);
  for (const x of [-span, span]) strip(1.3, (lanes.rackLane ?? lastProjectLane) - lanes.z[0], x, (lanes.z[0] + (lanes.rackLane ?? lastProjectLane)) / 2);
  for (const o of [...layout.desks, ...layout.stations]) { // the doorstep: from the door to the lane
    const lane = lanes.z.reduce((b, l) => (Math.abs(l - o.stand.z) < Math.abs(b - o.stand.z) ? l : b));
    strip(1.1, Math.abs(lane - o.stand.z) + 0.4, o.stand.x, (lane + o.stand.z) / 2);
  }

  // ---- everything clickable, by the key officeStates() uses for "where" (station:<id> / desk:<agent>) ----
  const objects = new Map();
  const pickables = [];
  const rects = []; // where buildings stand, so trees and flowers stay out of the way
  const addObject = ({ key, x, z, node, color, label, built, hitSize, ringRadius, labelClass, footprint }) => {
    const group = built.group;
    group.position.set(x, 0, z);
    scene.add(group);
    rects.push({ x, z, w: footprint.w, d: footprint.d });
    const ring = new THREE.Mesh(new THREE.RingGeometry(ringRadius * 0.9, ringRadius, 56), new THREE.MeshBasicMaterial({ color: SELECT_COLOR, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.09, z);
    scene.add(ring);
    const hit = new THREE.Mesh(new THREE.BoxGeometry(hitSize.w, hitSize.h, hitSize.d), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    hit.position.y = hitSize.h / 2;
    group.add(hit);
    pickables.push(hit);
    // while someone works inside: a spinning gear over the roof, windows aglow
    const gear = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.09, 6, 8), mat("#ffd45e", { emissive: "#ffd45e", glow: 0.6, rough: 0.5 })), { cast: false });
    gear.position.y = built.top + 0.7;
    gear.visible = false;
    group.add(gear);
    const text = document.createElement("div");
    text.className = `office-label ${labelClass}`;
    text.style.setProperty("--tag", color);
    text.textContent = label;
    labels.append(text);
    objects.set(key, { key, x, z, node, color, ring, text, glass: built.glass, gear, gearY: gear.position.y, glow: 0, lit: 0, hover: false, active: null });
    hit.userData.key = key;
  };
  for (const d of layout.desks) {
    addObject({ key: `desk:${d.agent}`, x: d.x, z: d.z, node: d.node, color: d.color, label: `${d.label}${d.reserved ? " · free house" : ""}`, built: makeHome(d), hitSize: { w: 4.2, h: 3.2, d: 2.8 }, ringRadius: 2.7, labelClass: "desk", footprint: FOOTPRINT.desk });
  }
  layout.stations.forEach((s, i) => {
    const silo = s.zone === "infra";
    const color = silo ? "#5b9dff" : "#2fb56a";
    addObject({
      key: `station:${s.node}`, x: s.x, z: s.z, node: s.node, color, label: s.label,
      built: silo ? makeSilo(i) : makeShop(s.node, i), hitSize: silo ? { w: 1.9, h: 3.4, d: 1.9 } : { w: 3.4, h: 3, d: 2.4 },
      ringRadius: silo ? 1.5 : 2.1, labelClass: silo ? "rack" : "project", footprint: silo ? FOOTPRINT.rack : FOOTPRINT.project,
    });
  });

  // ---- trees, flowers and lamps, placed where nothing else is ----
  const r = rng(2024);
  const onPath = (x, z) => lanes.z.some((l) => Math.abs(z - l) < 1.3 && Math.abs(x) < span + 1) || [...lanes.corridors, -span, span].some((c) => Math.abs(x - c) < 1.2 && z > lanes.z[0] - 1 && z < (lanes.rackLane ?? lastProjectLane) + 1);
  const blocked = (x, z, pad) => onPath(x, z) || rects.some((q) => Math.abs(x - q.x) < q.w / 2 + pad && Math.abs(z - q.z) < q.d / 2 + pad) || layout.stations.concat(layout.desks).some((o) => Math.hypot(x - o.stand.x, z - o.stand.z) < 1.4);
  const inside = (x, z, m) => x > minX + m && x < maxX - m && z > minZ + m && z < maxZ - m;
  let trees = 0;
  for (let tries = 0; tries < 900 && trees < 38; tries++) {
    const x = minX + 1 + r() * (width - 2);
    const z = minZ + 1 + r() * (depth - 2);
    const edge = !inside(x, z, 3.2);
    if (!edge && r() > 0.08) continue; // mostly around the rim, a few inside
    if (blocked(x, z, 1.2)) continue;
    const tree = makeTree(r);
    tree.position.set(x, 0, z);
    scene.add(tree);
    trees++;
  }
  const FLOWERS = 160;
  const flowers = new THREE.InstancedMesh(new THREE.SphereGeometry(0.09, 8, 6), mat("#ffffff", { rough: 0.7 }), FLOWERS);
  const dummy = new THREE.Object3D();
  const petals = ["#ff8fa8", "#ffd45e", "#ffffff", "#c98bd1", "#8ec9f0"];
  for (let i = 0, n = 0; n < FLOWERS && i < 2000; i++) {
    const x = minX + 0.8 + r() * (width - 1.6);
    const z = minZ + 0.8 + r() * (depth - 1.6);
    if (blocked(x, z, 0.6)) continue;
    dummy.position.set(x, 0.1, z);
    dummy.scale.setScalar(0.7 + r() * 0.8);
    dummy.updateMatrix();
    flowers.setMatrixAt(n, dummy.matrix);
    flowers.setColorAt(n, new THREE.Color(pick(petals, Math.floor(r() * 50))));
    n++;
  }
  scene.add(flowers);
  for (const [x, z] of [[-span + 1.2, lanes.z[0]], [span - 1.2, lanes.z[0]], [-span + 1.2, lastProjectLane], [span - 1.2, lastProjectLane], [0, lanes.z[0]], [0, lastProjectLane]]) {
    const lamp = makeLamp();
    lamp.position.set(x, 0, z + 0.9);
    scene.add(lamp);
  }
  const clouds = [];
  const cr = rng(9);
  for (let i = 0; i < 9; i++) {
    const c = makeCloud(cr);
    c.position.set(minX - 8 + cr() * (width + 16), -4.5 - cr() * 7, minZ - 6 + cr() * (depth + 12));
    c.scale.setScalar(1 + cr());
    scene.add(c);
    clouds.push({ c, speed: 0.15 + cr() * 0.25 });
  }

  // ---- zone captions ----
  const zoneLabels = [["AGENT HOMES", lanes.z[0]], ["PROJECT SHOPS", lanes.z[1] ?? lanes.z[0]], ["SERVER SILOS", lanes.rackLane ?? lanes.z.at(-1)]].map(([name, z]) => {
    const el = document.createElement("div");
    el.className = "office-zone";
    el.textContent = name;
    labels.append(el);
    return { el, x: -span - 0.2, z: z - 0.4 };
  });

  // ---- characters: one per house, starting at the door ----
  const STATE_WORDS = { idle: "idle", working: "working", waiting: "needs you", done: "done", collaborating: "pairing" };
  const avatars = layout.desks.map((d) => {
    const def = OFFICE_AGENTS.find((a) => a.id === d.agent);
    const a = makeAvatar(def);
    a.pos = { ...d.stand };
    a.goal = { ...d.stand };
    a.path = [];
    a.heading = 0;
    a.walking = false;
    a.def = d;
    a.mode = "idle";
    a.group.position.set(a.pos.x, 0, a.pos.z);
    scene.add(a.group);
    const tag = document.createElement("div");
    tag.className = "office-tag";
    tag.style.setProperty("--tag", d.color);
    const name = document.createElement("span");
    name.className = "name";
    const dot = document.createElement("i");
    const nameText = document.createElement("b");
    nameText.textContent = d.label;
    const state = document.createElement("em");
    state.textContent = STATE_WORDS.idle;
    name.append(dot, nameText, state);
    const bubble = document.createElement("span");
    bubble.className = "bubble";
    bubble.hidden = true;
    tag.append(name, bubble);
    labels.append(tag);
    a.tag = tag;
    a.bubble = bubble;
    a.stateEl = state;
    return a;
  });

  // ---- pollen and petals drifting in the light ----
  const MOTES = 120;
  const motePos = new Float32Array(MOTES * 3);
  const moteSpeed = new Float32Array(MOTES);
  const moteColor = new Float32Array(MOTES * 3);
  const palette = ["#fff6c9", "#ffd1dc", "#ffffff", "#ffe2a8"].map((c) => new THREE.Color(c));
  for (let i = 0; i < MOTES; i++) {
    motePos.set([minX + r() * width, 0.5 + r() * 7, minZ + r() * depth], i * 3);
    moteSpeed[i] = 0.05 + r() * 0.16;
    palette[i % palette.length].toArray(moteColor, i * 3);
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute("position", new THREE.BufferAttribute(motePos, 3));
  moteGeo.setAttribute("color", new THREE.BufferAttribute(moteColor, 3));
  const motes = new THREE.Points(moteGeo, new THREE.PointsMaterial({ size: 0.17, map: dotTexture(), vertexColors: true, transparent: true, opacity: 0.75, depthWrite: false }));
  motes.frustumCulled = false;
  scene.add(motes);

  // ---------- camera ----------

  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -200, 400);
  const view = { az: DEFAULT_AZIMUTH, el: DEFAULT_ELEVATION, zoom: 1, target: new THREE.Vector3(cx, 0, cz), goal: null };
  let w = 1;
  let h = 1;
  // Metres visible top to bottom at zoom 1: the whole island (less its margin) fits on any
  // window shape, seen from the default angle.
  const baseSize = () => {
    const room = (width + depth - 2) * Math.SQRT1_2;
    return Math.max(room * Math.sin(DEFAULT_ELEVATION) + 11, room / (w / h));
  };

  function placeCamera() {
    const half = baseSize() / view.zoom / 2;
    camera.left = -half * (w / h);
    camera.right = half * (w / h);
    camera.top = half;
    camera.bottom = -half;
    camera.updateProjectionMatrix();
    const d = 80;
    camera.position.set(view.target.x + Math.sin(view.az) * Math.cos(view.el) * d, view.target.y + Math.sin(view.el) * d, view.target.z + Math.cos(view.az) * Math.cos(view.el) * d);
    camera.lookAt(view.target);
  }

  function resize() {
    w = Math.max(container.clientWidth, 1);
    h = Math.max(container.clientHeight, 1);
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = `${w}px`;
    renderer.domElement.style.height = `${h}px`;
    placeCamera();
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const drag = { mode: null, x: 0, y: 0, moved: 0 };
  const el = renderer.domElement;
  el.addEventListener("contextmenu", (ev) => ev.preventDefault());
  el.addEventListener("pointerdown", (ev) => {
    el.setPointerCapture(ev.pointerId);
    Object.assign(drag, { mode: ev.button === 0 && !ev.shiftKey ? "rotate" : "pan", x: ev.clientX, y: ev.clientY, moved: 0 });
    view.goal = null;
  });
  el.addEventListener("pointermove", (ev) => {
    if (!drag.mode) return hover(ev);
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    drag.x = ev.clientX;
    drag.y = ev.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    if (drag.mode === "rotate") { // a light orbit: it stays an isometric view, never upside down
      view.az = clamp(view.az + dx * 0.005, DEFAULT_AZIMUTH - 0.7, DEFAULT_AZIMUTH + 0.7);
      view.el = clamp(view.el + dy * 0.004, 0.4, 1.05);
    } else {
      const perPixel = baseSize() / view.zoom / h;
      const right = { x: Math.cos(view.az), z: -Math.sin(view.az) };
      const away = { x: -Math.sin(view.az), z: -Math.cos(view.az) };
      view.target.x = clamp(view.target.x - right.x * dx * perPixel + away.x * (dy * perPixel) / Math.sin(view.el), minX, maxX);
      view.target.z = clamp(view.target.z - right.z * dx * perPixel + away.z * (dy * perPixel) / Math.sin(view.el), minZ, maxZ);
    }
    placeCamera();
  });
  el.addEventListener("pointerup", (ev) => {
    const click = drag.mode && drag.moved < 5;
    drag.mode = null;
    if (click) {
      const hit = pick3d(ev);
      if (hit?.node) onPick(hit.node);
    }
  });
  el.addEventListener("pointerleave", () => setHover(null));
  el.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    view.zoom = clamp(view.zoom * Math.exp(-ev.deltaY * 0.0012), 0.55, 3.5);
    placeCamera();
  }, { passive: false });

  // ---------- picking and hover ----------

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function pick3d(ev) {
    const rect = el.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickables, false)[0];
    return hit ? objects.get(hit.object.userData.key) : null;
  }
  let hovered = null;
  function setHover(o) {
    if (hovered === o) return;
    if (hovered) hovered.hover = false;
    hovered = o;
    if (o) o.hover = true;
    el.style.cursor = o?.node ? "pointer" : "";
  }
  const hover = (ev) => setHover(pick3d(ev));

  // ---------- state ----------

  let signalList = signals.reduce((list, s) => pushSignal(list, s), []);
  let states = {};
  let selectedKey = null;
  let lastStates = 0;

  function recompute(now = Date.now()) {
    states = officeStates({ layout, locator, signals: signalList, now, hold });
    lastStates = now;
    for (const o of objects.values()) o.active = null;
    for (const a of avatars) {
      const st = states[a.def.agent];
      if (st.mode !== "idle") {
        const target = objects.get(st.key);
        if (target) target.active = a.def.color;
      }
    }
  }

  // ---------- frame loop ----------

  const tmp = new THREE.Vector3();
  let raf = 0;
  let last = 0;
  let running = false;
  let blurred = !document.hasFocus();

  function placeLabel(node, x, y, z, dy = 0) {
    tmp.set(x, y, z).project(camera);
    const inView = tmp.z < 1 && Math.abs(tmp.x) < 1.15 && Math.abs(tmp.y) < 1.15;
    node.style.visibility = inView ? "visible" : "hidden";
    if (inView) node.style.transform = `translate(${((tmp.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-tmp.y * 0.5 + 0.5) * h + dy).toFixed(1)}px) translate(-50%, -100%)`;
  }

  // Walk the route to the target, corner by corner; a new target means a new route.
  function walk(a, st, dt) {
    if (Math.hypot(st.target.x - a.goal.x, st.target.z - a.goal.z) > 0.01) {
      a.goal = { ...st.target };
      if (REDUCED) a.pos = { ...st.target };
      a.path = REDUCED ? [] : routeBetween(layout, a.pos, st.target);
    }
    const next = a.path[0] ?? a.goal;
    const step = stepToward(a.pos, next, WALK_SPEED * dt);
    a.pos = { ...step.pos };
    if (step.arrived && a.path.length) a.path.shift();
    a.walking = a.path.length > 0 || !step.arrived;
    if (a.walking && !(step.arrived && !a.path.length)) a.heading = turn(a.heading, step.heading, dt * 10);
    else {
      const at = objects.get(st.key);
      if (at) a.heading = turn(a.heading, Math.atan2(at.x - a.pos.x, at.z - a.pos.z), dt * 8);
    }
  }

  function frame(t) {
    raf = requestAnimationFrame(frame);
    // Unfocused but still on screen: keep it alive at a few frames a second (BLUR_FPS 0 pauses it).
    if (blurred && (!BLUR_FPS || t - last < 1000 / BLUR_FPS)) return;
    // rAF's timestamp can be older than the performance.now() the loop started with: never negative.
    const dt = Math.min(Math.max((t - last) / 1000 || 0, 0), 0.1);
    last = t;
    const now = Date.now();
    if (now - lastStates > 250) recompute(now);
    const sec = t / 1000;

    if (view.goal) { // fly to a node picked elsewhere
      view.target.x += (view.goal.x - view.target.x) * Math.min(1, dt * 4);
      view.target.z += (view.goal.z - view.target.z) * Math.min(1, dt * 4);
      if (Math.hypot(view.goal.x - view.target.x, view.goal.z - view.target.z) < 0.05) view.goal = null;
      placeCamera();
    }

    for (const a of avatars) {
      const st = states[a.def.agent];
      walk(a, st, dt);
      animate(a, st, sec);
      a.group.position.set(a.pos.x, 0, a.pos.z);
      a.group.rotation.y = a.heading;
      const free = a.def.reserved && st.mode === "idle";
      for (const m of a.materials) {
        m.transparent = free;
        m.opacity = free ? 0.4 : 1;
      }
      a.bubble.hidden = st.mode === "idle" || !st.text;
      if (!a.bubble.hidden) {
        a.bubble.textContent = st.text;
        a.bubble.className = `bubble ${st.kind}${st.mode === "collaborating" ? " together" : ""}`;
      }
      a.tag.classList.toggle("busy", st.mode !== "idle");
      if (a.mode !== st.mode) {
        a.mode = st.mode;
        a.stateEl.textContent = STATE_WORDS[st.mode] ?? st.mode;
      }
    }
    placeTags();

    if (!REDUCED) {
      const p = moteGeo.attributes.position;
      for (let i = 0; i < MOTES; i++) {
        let y = p.getY(i) + moteSpeed[i] * dt;
        if (y > 8) y = 0.5;
        p.setY(i, y);
        p.setX(i, p.getX(i) + Math.sin(sec * 0.3 + i) * dt * 0.15);
      }
      p.needsUpdate = true;
      for (const k of clouds) {
        k.c.position.x += k.speed * dt;
        if (k.c.position.x > maxX + 14) k.c.position.x = minX - 14;
      }
    }

    for (const o of objects.values()) {
      const want = o.active ? 0.9 : o.key === selectedKey ? 0.8 : o.hover ? 0.5 : 0;
      o.glow += (want - o.glow) * Math.min(1, dt * 8);
      o.ring.material.opacity = o.glow;
      o.ring.material.color.set(o.active ?? (o.key === selectedKey ? SELECT_COLOR : "#ffffff"));
      o.ring.visible = o.glow > 0.01;
      o.lit += ((o.active ? 1.7 : 0.35) - o.lit) * Math.min(1, dt * 5); // windows light up while someone works inside
      o.glass.emissiveIntensity = o.lit;
      o.gear.visible = Boolean(o.active);
      if (o.active && !REDUCED) {
        o.gear.rotation.z = sec * 2.2;
        o.gear.position.y = o.gearY + Math.sin(sec * 3) * 0.08;
      }
      o.text.classList.toggle("hot", o.hover || o.key === selectedKey || Boolean(o.active));
      placeLabel(o.text, o.x, 0.05, o.z + (o.key.startsWith("desk:") ? -1.5 : 1.0), 12);
    }
    for (const z of zoneLabels) placeLabel(z.el, z.x, 0.1, z.z);
    renderer.render(scene, camera);
  }

  // Names and bubbles over the characters. Agents that gather at one shop would pile their
  // bubbles on top of each other, so from the lowest on screen up, each is lifted above any
  // tag it overlaps (or stacked downwards when there is no room under the top bar). All
  // measuring comes first, then all writing: one layout per frame.
  function placeTags() {
    const tags = avatars.map((a) => {
      tmp.set(a.pos.x, 2.7, a.pos.z).project(camera);
      const { width: tw, height: th } = a.tag.getBoundingClientRect();
      return { a, tw, th, x: (tmp.x * 0.5 + 0.5) * w, y: (-tmp.y * 0.5 + 0.5) * h, inView: tmp.z < 1 && Math.abs(tmp.x) < 1.15 && Math.abs(tmp.y) < 1.15 };
    }).sort((p, q) => q.y - p.y);
    const placed = [];
    const clash = (t) => placed.find((p) => Math.abs(t.x - p.x) < (t.tw + p.tw) / 2 + 4 && t.y > p.y - p.th - 4 && t.y - t.th < p.y + 4);
    const TOP = 60; // below the top bar
    for (const t of tags.filter((x) => x.inView)) {
      const home = t.y;
      for (let pass = 0, hit; pass < tags.length && (hit = clash(t)); pass++) t.y = hit.y - hit.th - 4;
      if (t.y - t.th < TOP && t.y !== home) {
        t.y = home;
        for (let pass = 0, hit; pass < tags.length && (hit = clash(t)); pass++) t.y = hit.y + t.th + 4;
      }
      placed.push(t);
    }
    for (const t of tags) {
      t.a.tag.style.visibility = t.inView ? "visible" : "hidden";
      if (t.inView) t.a.tag.style.transform = `translate(${t.x.toFixed(1)}px, ${t.y.toFixed(1)}px) translate(-50%, -100%)`;
    }
  }

  const turn = (from, to, k) => {
    let d = ((to - from + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    d *= Math.min(1, k);
    return from + d;
  };

  // Walking waddles on little feet; working types on a laptop; waiting waves; done cheers
  // under a ring of stars; idle breathes.
  function animate(a, st, sec) {
    const [left, right] = a.arms;
    const k = a.def.agent.length; // so the agents do not move in lockstep
    const working = !a.walking && (st.mode === "working" || st.mode === "collaborating");
    a.laptop.visible = working;
    a.stars.visible = !a.walking && st.mode === "done";
    left.rotation.set(0, 0, 0);
    right.rotation.set(0, 0, 0);
    a.head.rotation.set(0, 0, 0);
    a.group.rotation.z = 0;
    a.feet[0].position.z = a.feet[1].position.z = 0.05;
    let bob = 0;
    if (REDUCED) {
      if (working) left.rotation.x = right.rotation.x = -1.0;
      return;
    }
    if (a.walking) {
      const s = Math.sin(sec * 11 + k);
      bob = Math.abs(s) * 0.1;
      a.group.rotation.z = s * 0.07; // a little waddle
      left.rotation.x = s * 0.8;
      right.rotation.x = -s * 0.8;
      a.feet[0].position.z = 0.05 + s * 0.16;
      a.feet[1].position.z = 0.05 - s * 0.16;
    } else if (working) {
      left.rotation.x = -1.1 + Math.sin(sec * 17 + k) * 0.12;
      right.rotation.x = -1.1 + Math.sin(sec * 17 + k + 2) * 0.12;
      a.head.rotation.x = 0.14 + Math.sin(sec * 3 + k) * 0.03;
      a.head.rotation.y = st.mode === "collaborating" ? Math.sin(sec * 1.6 + k) * 0.5 : 0;
    } else if (st.mode === "done") {
      bob = Math.abs(Math.sin(sec * 5 + k)) * 0.22; // a cheer
      left.rotation.z = 2.6;
      right.rotation.z = -2.6;
      a.stars.rotation.y = sec * 2.5;
    } else if (st.mode === "waiting") {
      right.rotation.z = -2.6 + Math.sin(sec * 7) * 0.3; // a wave
      bob = Math.abs(Math.sin(sec * 4)) * 0.06;
    } else {
      bob = Math.sin(sec * 1.8 + k) * 0.02;
    }
    a.body.position.y = 0.55 + bob;
    a.head.position.y = 1.1 + bob * 1.2;
  }

  // ---------- demo: a few made-up signals, local to this page ----------

  let demoCount = 0;
  const demoTimers = [];
  function demo() {
    demoTimers.forEach(clearTimeout);
    demoTimers.length = 0;
    const projects = layout.stations.filter((s) => s.zone === "project").map((s) => s.node);
    const silos = layout.stations.filter((s) => s.zone === "infra").map((s) => s.node);
    const at = (list, i) => list[i % Math.max(list.length, 1)];
    const script = [
      [0, "claude-code", at(projects, 2), "working", "Refactoring the importer"],
      [1200, "hermes", at(silos, 0), "working", "Checking the deploy"],
      [2400, "buzz", at(projects, 7), "working", "Drafting a launch thread"],
      [3600, "gemini", at(projects, 2), "working", "Reviewing the pull request"],
      [4800, "chatgpt", at(projects, 11), "working", "Summarising the docs"],
      [11000, "claude-code", at(projects, 2), "done", "All tests green"],
      [13000, "buzz", at(projects, 7), "waiting", "Needs your OK to post"],
      [16000, "hermes", at(silos, 0), "done", "Deploy healthy"],
      [18000, "gemini", at(projects, 2), "done", "Review finished"],
      [20000, "chatgpt", at(projects, 11), "done", "Docs summarised"],
    ];
    for (const [ms, agent, node, kind, text] of script) {
      demoTimers.push(setTimeout(() => {
        signalList = pushSignal(signalList, { id: `demo-${++demoCount}`, agent, node, kind, text, at: Date.now() });
        recompute();
      }, ms));
    }
  }
  demoButton.addEventListener("click", demo);

  // ---------- public ----------

  function start() {
    if (running || document.hidden) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }
  const visible = () => !container.hidden;
  addEventListener("blur", () => (blurred = true));
  addEventListener("focus", () => (blurred = false));
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : visible() && start()));
  new ResizeObserver(() => visible() && resize()).observe(container);

  resize();
  recompute();
  return {
    // The office is on screen: size it (it was hidden) and run the loop.
    show() {
      container.hidden = false;
      resize();
      recompute();
      start();
    },
    // The office is off screen: stop the loop completely — no GPU, no timers.
    hide() {
      container.hidden = true;
      stop();
    },
    // A signal from the shared feed (app.js owns the one connection): whoever it names starts walking.
    signal(s) {
      signalList = pushSignal(signalList, s);
      recompute();
    },
    // Highlight the house, shop or silo that stands for a node, and fly the camera to it.
    select(id) {
      const place = id ? locator.resolve(id) : null;
      selectedKey = place?.key ?? null;
      const o = selectedKey && objects.get(selectedKey);
      if (o) view.goal = { x: o.x, z: o.z };
    },
    demo,
    layout,
  };
}
