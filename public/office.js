// The 3D office: an isometric diorama of the stack, a floating island in the same starfield as
// the map. Agents hover at their desks and walk to the project or infrastructure station a
// signal names, with a speech bubble of what they report. Everything that decides *where*
// lives in office-layout.js (pure, tested); this file only draws it with plain three.js —
// procedural PBR shapes, a generated reflection environment and canvas textures: no models, no
// image files, no build step, no post-processing add-ons (they would need an import map, which
// the CSP forbids). Loaded on demand by app.js, so the map never pays for three.js until the
// office is opened. Names and bubbles are DOM cards positioned over the canvas: sharp text,
// readable by screen readers. The frame loop stops completely while the office is hidden or the
// tab is in the background, and slows down while the window is simply unfocused.
import * as THREE from "/vendor/three.module.js";
import { OFFICE_AGENTS, createLocator, layoutOffice, officeStates, pushSignal, stepToward } from "./office-layout.js";

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const WALK_SPEED = 3.2; // metres per second
const BLUR_FPS = 12;    // frame rate while the window is unfocused but still visible; 0 pauses it
const ACCENT = "#6aa8ff";
const PROJECT_COLOR = "#38d989"; // layer-products
const INFRA_COLOR = "#5b9dff";   // layer-hosting
const AGENT_ZONE_COLOR = "#b47cff";
const DEFAULT_AZIMUTH = Math.PI / 4;
const DEFAULT_ELEVATION = 0.62;
const HEAD_Y = 1.78;
const BODY_Y = 0.92;

// ---------- materials and textures ----------

// Stylised PBR: a base colour, how rough and how metallic, and optionally a glow.
const pbr = (color, { rough = 0.55, metal = 0.2, emissive = null, glow = 1, emissiveMap = null } = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, emissive: emissive ?? 0x000000, emissiveIntensity: emissive || emissiveMap ? glow : 0, emissiveMap });
const box = (w, h, d, material, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  return m;
};
const cyl = (rt, rb, h, material, x = 0, y = 0, z = 0, seg = 20) => {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), material);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  return m;
};

function canvasTexture(size, draw, { repeat = false } = {}) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d"), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// What a monitor shows: a title bar and rows of "code" in the desk's colour, the same picture
// for the same colour so every project is not a different texture.
const screens = new Map();
function screenTexture(color) {
  if (!screens.has(color)) {
    screens.set(color, canvasTexture(128, (g, s) => {
      g.fillStyle = "#05080f";
      g.fillRect(0, 0, s, s);
      g.fillStyle = color;
      g.globalAlpha = 0.9;
      g.fillRect(6, 6, s - 12, 9);
      let seed = [...color].reduce((n, ch) => n * 31 + ch.charCodeAt(0), 7);
      const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      for (let y = 24; y < s - 8; y += 9) {
        g.globalAlpha = 0.35 + rand() * 0.5;
        const indent = Math.floor(rand() * 3) * 10;
        g.fillRect(8 + indent, y, 14 + rand() * (s - 40 - indent), 4);
      }
    }));
  }
  return screens.get(color);
}

// The floor: one tile with a bevel and a faint highlight, repeated.
const tileTexture = () => canvasTexture(256, (g, s) => {
  g.fillStyle = "#070c1c";
  g.fillRect(0, 0, s, s);
  const edge = g.createLinearGradient(0, 0, s, s);
  edge.addColorStop(0, "#152448");
  edge.addColorStop(1, "#0c1632");
  g.fillStyle = edge;
  g.fillRect(5, 5, s - 10, s - 10);
  g.strokeStyle = "rgba(120, 160, 255, 0.28)";
  g.lineWidth = 2;
  g.strokeRect(5, 5, s - 10, s - 10);
  g.fillStyle = "rgba(160, 190, 255, 0.5)";
  for (const [x, y] of [[14, 14], [s - 14, 14], [14, s - 14], [s - 14, s - 14]]) g.fillRect(x - 1.5, y - 1.5, 3, 3);
}, { repeat: true });

const dotTexture = () => canvasTexture(64, (g, s) => {
  const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.35, "rgba(255,255,255,0.35)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, s, s);
});

// A small studio to reflect: a night-blue dome with a few bright neon strips. Baked once into
// an environment map so the metals have something to mirror; it is never drawn itself.
function makeEnvironment(renderer) {
  const env = new THREE.Scene();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(40, 32, 16), new THREE.MeshBasicMaterial({
    side: THREE.BackSide,
    map: canvasTexture(64, (g, s) => {
      const v = g.createLinearGradient(0, 0, 0, s);
      v.addColorStop(0, "#1c2250");
      v.addColorStop(0.5, "#0b1030");
      v.addColorStop(1, "#04060c");
      g.fillStyle = v;
      g.fillRect(0, 0, s, s);
    }),
  }));
  env.add(dome);
  for (const [color, x, y, z, ry] of [[0x2fd4e8, -22, 14, -10, 0.9], [0xff79c6, 22, 12, 8, -0.8], [0xffd9b0, 0, 28, 0, 0]]) {
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(26, 3), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(5), side: THREE.DoubleSide }));
    strip.position.set(x, y, z);
    strip.rotation.y = ry;
    if (y > 20) strip.rotation.x = Math.PI / 2;
    env.add(strip);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(env, 0.03).texture;
  pmrem.dispose();
  return texture;
}

// ---------- things in the room ----------

// Blinking status lights: every rack LED shares one of three materials, so blinking them is
// three assignments a frame.
const leds = [
  { mat: pbr("#031018", { emissive: "#2fd4e8", glow: 2.4 }), speed: 1.7, phase: 0 },
  { mat: pbr("#03120a", { emissive: "#38d989", glow: 2.4 }), speed: 0.9, phase: 2 },
  { mat: pbr("#120a03", { emissive: "#ffc04d", glow: 2.4 }), speed: 2.6, phase: 4 },
];

function chair() {
  const g = new THREE.Group();
  const fabric = pbr("#161d38", { rough: 0.8, metal: 0.05 });
  const metal = pbr("#1b2340", { rough: 0.35, metal: 0.8 });
  g.add(cyl(0.38, 0.34, 0.12, fabric, 0, 0.55, 0, 24));
  const back = box(0.74, 0.8, 0.1, fabric, 0, 1.0, 0.36);
  back.rotation.x = -0.12;
  g.add(back, cyl(0.04, 0.04, 0.45, metal, 0, 0.3, 0, 8));
  for (let i = 0; i < 5; i++) {
    const leg = box(0.5, 0.05, 0.06, metal, 0, 0.07, 0);
    leg.rotation.y = (i / 5) * Math.PI * 2;
    leg.position.set(Math.sin(leg.rotation.y) * 0.22, 0.07, Math.cos(leg.rotation.y) * 0.22);
    g.add(leg);
  }
  return g;
}

// An agent's desk: a wide monitor showing its colour, a glowing edge, a lamp and a chair.
function makeDesk(color, reserved) {
  const g = new THREE.Group();
  const top = pbr("#1a2342", { rough: 0.35, metal: 0.5 });
  const frame = pbr("#0d1226", { rough: 0.3, metal: 0.8 });
  const screen = pbr("#06090f", { emissiveMap: screenTexture(color), emissive: "#ffffff", glow: reserved ? 0.18 : 1.3, rough: 0.2, metal: 0 });
  const accent = pbr("#050810", { emissive: color, glow: reserved ? 0.4 : 2.2 });
  g.add(box(3.5, 0.14, 1.7, top, 0, 0.82, 0));
  g.add(box(3.5, 0.03, 0.03, accent, 0, 0.78, 0.85)); // glowing front edge
  for (const x of [-1.55, 1.55]) g.add(box(0.12, 0.76, 1.5, frame, x, 0.4, 0));
  g.add(box(2.0, 1.0, 0.09, frame, 0, 1.55, -0.4), box(1.86, 0.86, 0.02, screen, 0, 1.55, -0.34), box(0.14, 0.45, 0.14, frame, 0, 1.08, -0.4));
  g.add(box(1.05, 0.04, 0.34, pbr("#0f152b", { rough: 0.5, metal: 0.4 }), 0, 0.91, 0.3), box(1.0, 0.012, 0.05, accent, 0, 0.935, 0.2));
  // a desk lamp
  const lampBulb = pbr("#150f05", { emissive: "#ffd9a0", glow: reserved ? 0.3 : 2.0 });
  g.add(cyl(0.12, 0.14, 0.04, frame, -1.4, 0.92, 0.2, 16), cyl(0.02, 0.02, 0.55, frame, -1.4, 1.2, 0.2, 8), box(0.3, 0.06, 0.12, lampBulb, -1.32, 1.5, 0.2));
  const seat = chair();
  seat.position.z = 1.55;
  g.add(seat);
  return g;
}

// A project's workstation: a smaller desk, a monitor and one prop that varies per project.
function makeWorkstation(color, variant) {
  const g = new THREE.Group();
  const top = pbr("#182140", { rough: 0.4, metal: 0.4 });
  const frame = pbr("#0d1226", { rough: 0.3, metal: 0.8 });
  const screen = pbr("#06090f", { emissiveMap: screenTexture(color), emissive: "#ffffff", glow: 1.2, rough: 0.2, metal: 0 });
  g.add(box(2.4, 0.12, 1.3, top, 0, 0.72, 0));
  for (const x of [-1.1, 1.1]) g.add(box(0.1, 0.68, 1.1, frame, x, 0.36, 0));
  g.add(box(1.35, 0.86, 0.07, frame, 0, 1.3, -0.25), box(1.25, 0.76, 0.02, screen, 0, 1.3, -0.205), box(0.1, 0.3, 0.1, frame, 0, 0.92, -0.25));
  g.add(box(0.7, 0.03, 0.24, pbr("#0f152b", { rough: 0.5, metal: 0.4 }), 0, 0.79, 0.25));
  const leaf = pbr("#1f7a4d", { rough: 0.8, metal: 0 });
  if (variant === 0) { // a plant
    g.add(cyl(0.1, 0.08, 0.16, pbr("#e8eeff", { rough: 0.6, metal: 0 }), 0.9, 0.86, 0.1, 12));
    const bush = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), leaf);
    bush.position.set(0.9, 1.08, 0.1);
    bush.castShadow = true;
    g.add(bush);
  } else if (variant === 1) { // a stack of books
    g.add(box(0.36, 0.06, 0.26, pbr(color, { rough: 0.6, metal: 0 }), 0.85, 0.81, 0.12), box(0.32, 0.06, 0.24, pbr("#e8eeff", { rough: 0.6, metal: 0 }), 0.85, 0.87, 0.12));
  } else { // a mug
    g.add(cyl(0.07, 0.07, 0.13, pbr("#e8eeff", { rough: 0.4, metal: 0 }), -0.85, 0.84, 0.15, 12));
  }
  const seat = chair();
  seat.scale.setScalar(0.85);
  seat.position.z = 1.35;
  g.add(seat);
  return g;
}

// A server rack: dark brushed metal, a row of units and blinking status lights.
function makeRack(color) {
  const g = new THREE.Group();
  const shell = pbr("#0d1328", { rough: 0.32, metal: 0.9 });
  const unit = pbr("#121a36", { rough: 0.4, metal: 0.7 });
  const trim = pbr("#040810", { emissive: color, glow: 2.2 });
  g.add(box(1.5, 2.7, 1.1, shell, 0, 1.35, 0));
  g.add(box(1.56, 0.1, 1.16, unit, 0, 2.74, 0), box(1.56, 0.1, 1.16, unit, 0, 0.05, 0));
  g.add(box(1.0, 0.03, 0.03, trim, 0, 2.62, 0.56)); // glowing top edge
  for (let i = 0; i < 6; i++) {
    const y = 0.42 + i * 0.37;
    g.add(box(1.3, 0.3, 0.06, unit, 0, y, 0.56));
    for (let k = 0; k < 3; k++) {
      const led = leds[(i + k) % leds.length];
      g.add(box(0.07, 0.05, 0.03, led.mat, -0.5 + k * 0.14, y + 0.05, 0.6));
    }
    g.add(box(0.5, 0.025, 0.02, pbr("#05080f", { rough: 0.8, metal: 0 }), 0.3, y - 0.02, 0.6)); // vent slot
  }
  return g;
}

// A glowing ring on the floor under a desk or station: hover, selection and "someone is working here".
function makeRing(radius) {
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius * 0.86, radius, 56), new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  return ring;
}

// ---------- avatars ----------

// A little hovering robot: glossy body, a floating head with a dark visor and lit eyes, a glow
// pad under it. Each agent has its own colour and its own accessory, so they read apart from
// far away.
function makeAvatar(agent) {
  const g = new THREE.Group();
  const mats = [];
  const track = (m) => (mats.push(m), m);
  const shell = track(pbr(agent.color, { rough: 0.28, metal: 0.35, emissive: agent.color, glow: 0.22 }));
  const light = track(pbr("#060912", { emissive: agent.color, glow: 2.6 }));
  const visor = track(pbr("#05070f", { rough: 0.12, metal: 0.9 }));
  const dark = track(pbr("#0b1020", { rough: 0.4, metal: 0.7 }));

  const body = new THREE.Group();
  body.position.y = BODY_Y;
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.27, 0.46, 6, 16), shell);
  torso.castShadow = true;
  const belt = new THREE.Mesh(new THREE.TorusGeometry(0.275, 0.025, 8, 28), light);
  belt.rotation.x = Math.PI / 2;
  belt.position.y = -0.12;
  const chest = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), light);
  chest.position.set(0, 0.1, 0.27);
  body.add(torso, belt, chest);
  g.add(body);

  // the hover pad: a dark disc with a glowing rim, floating just above the floor
  const pad = new THREE.Group();
  pad.position.y = 0.16;
  const disc = cyl(0.3, 0.22, 0.08, dark, 0, 0, 0, 24);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.02, 8, 32), light);
  rim.rotation.x = Math.PI / 2;
  pad.add(disc, rim);
  g.add(pad);

  const head = new THREE.Group();
  head.position.y = HEAD_Y;
  g.add(head);
  const ball = (r, m = shell) => {
    const s = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), m);
    s.castShadow = true;
    return s;
  };
  const face = (r, y = 0) => { // a dark visor with two lit eyes, on the front of a head of radius r
    const v = ball(r * 0.82, visor);
    v.scale.set(1, 0.62, 0.5);
    v.position.set(0, y, r * 0.62);
    head.add(v);
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(r * 0.1, 8, 6), light);
      eye.position.set(s * r * 0.32, y, r * 0.92);
      head.add(eye);
    }
  };
  switch (agent.id) {
    case "claude-code": { // a starburst above the head, like its mark
      head.add(ball(0.3));
      face(0.3);
      for (let i = 0; i < 3; i++) {
        const ray = box(0.04, 0.34, 0.04, light, 0, 0.5, 0);
        ray.rotation.z = (i * Math.PI) / 3;
        ray.castShadow = false;
        head.add(ray);
      }
      break;
    }
    case "hermes": { // winged
      head.add(ball(0.29));
      face(0.29);
      for (const s of [-1, 1]) {
        for (let k = 0; k < 3; k++) {
          const feather = box(0.34 - k * 0.07, 0.035, 0.1, light, s * (0.42 + k * 0.03), 0.06 - k * 0.07, -0.02);
          feather.rotation.z = s * (0.35 - k * 0.08);
          feather.castShadow = false;
          head.add(feather);
        }
      }
      break;
    }
    case "buzz": { // antennae
      head.add(ball(0.29));
      face(0.29);
      for (const s of [-1, 1]) {
        const stalk = cyl(0.015, 0.015, 0.34, dark, s * 0.11, 0.42, 0, 6);
        stalk.rotation.z = -s * 0.32;
        const tip = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), light);
        tip.position.set(s * 0.2, 0.58, 0);
        head.add(stalk, tip);
      }
      break;
    }
    case "gemini": { // twin heads
      for (const s of [-1, 1]) {
        const twin = ball(0.2);
        twin.position.set(s * 0.2, 0, 0);
        head.add(twin);
        for (const e of [-1, 1]) {
          const eye = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 6), light);
          eye.position.set(s * 0.2 + e * 0.06, 0.02, 0.18);
          head.add(eye);
        }
      }
      break;
    }
    case "chatgpt": { // a halo
      head.add(ball(0.3));
      face(0.3);
      const halo = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.03, 10, 32), light);
      halo.rotation.x = Math.PI / 2;
      halo.position.y = 0.5;
      head.add(halo);
      break;
    }
    default:
      head.add(ball(0.3));
      face(0.3);
  }
  // Arms are small capsules that swing from the shoulder.
  const arms = [-1, 1].map((s) => {
    const pivot = new THREE.Group();
    pivot.position.set(s * 0.4, 1.28, 0);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.3, 4, 8), shell);
    arm.position.y = -0.2;
    arm.castShadow = true;
    pivot.add(arm);
    g.add(pivot);
    return pivot;
  });
  return { group: g, body, head, arms, pad, materials: mats };
}

// ---------- the office ----------

export function createOffice(container, { stack, signals = [], hold, onPick = () => {} }) {
  const layout = layoutOffice(stack);
  const locator = createLocator(stack, layout);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // three 0.187 removed PCFSoftShadowMap: this one is soft now
  renderer.domElement.className = "office-canvas";
  container.append(renderer.domElement);
  const labels = document.createElement("div");
  labels.className = "office-labels";
  const hint = document.createElement("div");
  hint.className = "office-hint";
  hint.textContent = "drag: rotate · right-drag: pan · wheel: zoom · click a desk or station";
  container.append(labels, hint);

  const scene = new THREE.Scene();
  scene.environment = makeEnvironment(renderer);
  scene.environmentIntensity = 0.7;

  const { minX, maxX, minZ, maxZ } = layout.bounds;
  const width = maxX - minX;
  const depth = maxZ - minZ;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;

  // ---- light: a dim violet night, a warm key from above with soft shadows, neon fills ----
  scene.add(new THREE.AmbientLight(0x1a1b35, 2.2));
  scene.add(new THREE.HemisphereLight(0x4a5cc0, 0x140a28, 0.55));
  const key = new THREE.DirectionalLight(0xffd9b0, 2.1);
  key.position.set(cx - 14, 26, cz + 10);
  key.target.position.set(cx, 0, cz);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const reach = Math.max(width, depth) * 0.62;
  Object.assign(key.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 1, far: 90 });
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.04;
  scene.add(key, key.target);
  const rim = new THREE.DirectionalLight(0x6a8cff, 0.7);
  rim.position.set(cx + 18, 14, cz - 16);
  scene.add(rim);
  for (const [color, x, z, power] of [[0x2fd4e8, cx, minZ + 5, 50], [0xff79c6, cx, maxZ - 3, 45], [0xb47cff, cx - 12, cz, 26], [0x38d989, cx + 12, cz, 16]]) {
    const p = new THREE.PointLight(color, power, 36, 1.6);
    p.position.set(x, 6, z);
    scene.add(p);
  }

  // ---- the island: a tiled slab with a metal edge, a neon rim and a glow underneath ----
  const island = new THREE.Group();
  const tiles = tileTexture();
  tiles.repeat.set(width / 2, depth / 2);
  tiles.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const side = pbr("#0b1126", { rough: 0.3, metal: 0.85 });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(width, 0.7, depth), [side, side, pbr("#ffffff", { rough: 0.38, metal: 0.25, emissiveMap: tiles, emissive: "#ffffff", glow: 0.18 }), side, side, side]);
  slab.material[2].map = tiles;
  slab.position.set(cx, -0.35, cz);
  slab.receiveShadow = true;
  const keel = new THREE.Mesh(new THREE.BoxGeometry(width * 0.82, 0.5, depth * 0.82), pbr("#080d1e", { rough: 0.4, metal: 0.8 }));
  keel.position.set(cx, -0.95, cz);
  const keel2 = new THREE.Mesh(new THREE.BoxGeometry(width * 0.55, 0.45, depth * 0.55), pbr("#060a18", { rough: 0.4, metal: 0.8 }));
  keel2.position.set(cx, -1.4, cz);
  island.add(slab, keel, keel2);
  const neon = (w, d, x, z, color, glow = 2.4) => {
    const m = box(w, 0.05, d, pbr("#04060c", { emissive: color, glow }), x, 0.025, z);
    m.castShadow = false;
    return m;
  };
  const e = 0.35; // perimeter neon: cyan along the long sides, magenta across
  island.add(neon(width - 2 * e, 0.09, cx, minZ + e, "#2fd4e8"), neon(width - 2 * e, 0.09, cx, maxZ - e, "#2fd4e8"), neon(0.09, depth - 2 * e, minX + e, cz, "#ff79c6"), neon(0.09, depth - 2 * e, maxX - e, cz, "#ff79c6"));
  const underglow = new THREE.Mesh(new THREE.PlaneGeometry(width * 1.7, depth * 1.7), new THREE.MeshBasicMaterial({ map: dotTexture(), color: 0x5b6cff, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
  underglow.rotation.x = -Math.PI / 2;
  underglow.position.set(cx, -2.4, cz);
  island.add(underglow);

  // zone pads: a raised plate under each part of the office, edged with its colour
  const zones = [];
  const pad = (name, color, items, margin) => {
    if (!items.length) return;
    const x0 = Math.min(...items.map((o) => o.x)) - margin.x;
    const x1 = Math.max(...items.map((o) => o.x)) + margin.x;
    const z0 = Math.min(...items.map((o) => o.z)) - margin.z0;
    const z1 = Math.max(...items.map((o) => o.z)) + margin.z1;
    const plate = box(x1 - x0, 0.06, z1 - z0, pbr("#0a1330", { rough: 0.35, metal: 0.5 }), (x0 + x1) / 2, 0.03, (z0 + z1) / 2);
    plate.castShadow = false;
    const line = (w, d, x, z) => island.add(neon(w, d, x, z, color, 1.4));
    island.add(plate);
    line(x1 - x0, 0.06, (x0 + x1) / 2, z0);
    line(x1 - x0, 0.06, (x0 + x1) / 2, z1);
    line(0.06, z1 - z0, x0, (z0 + z1) / 2);
    line(0.06, z1 - z0, x1, (z0 + z1) / 2);
    zones.push({ name, color, x: x0 + 0.4, z: z0 + 0.3 });
  };
  pad("AGENTS", AGENT_ZONE_COLOR, layout.desks, { x: 3.2, z0: 2.4, z1: 3.3 });
  pad("PROJECTS", PROJECT_COLOR, layout.stations.filter((s) => s.zone === "project"), { x: 3.2, z0: 2.2, z1: 3.1 });
  pad("INFRASTRUCTURE", INFRA_COLOR, layout.stations.filter((s) => s.zone === "infra"), { x: 2.2, z0: 2.4, z1: 1.9 });
  scene.add(island);
  const zoneLabels = zones.map((z) => {
    const el = document.createElement("div");
    el.className = "office-zone";
    el.style.setProperty("--tag", z.color);
    el.textContent = z.name;
    labels.append(el);
    return { ...z, el };
  });

  // ---- everything clickable, by the key officeStates() uses for "where" (station:<id> / desk:<agent>) ----
  const objects = new Map();
  const pickables = [];
  const addObject = ({ key: id, x, z, node, color, label, build, ringRadius, labelClass }) => {
    const group = build();
    group.position.set(x, 0, z);
    scene.add(group);
    const ring = makeRing(ringRadius);
    ring.position.set(x, 0.07, z);
    scene.add(ring);
    const hit = new THREE.Mesh(new THREE.BoxGeometry(3.6, 2.8, 2.6), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    hit.position.y = 1.4;
    group.add(hit);
    pickables.push(hit);
    const text = document.createElement("div");
    text.className = `office-label ${labelClass}`;
    text.style.setProperty("--tag", color);
    text.textContent = label;
    labels.append(text);
    objects.set(id, { key: id, x, z, node, color, ring, text, glow: 0, hover: false, active: null });
    hit.userData.key = id;
  };
  for (const d of layout.desks) {
    addObject({ key: `desk:${d.agent}`, x: d.x, z: d.z, node: d.node, color: d.color, label: `${d.label}${d.reserved ? " · free desk" : ""}`, build: () => makeDesk(d.color, d.reserved), ringRadius: 2.7, labelClass: "desk" });
  }
  layout.stations.forEach((s, i) => {
    const rack = s.zone === "infra";
    const color = rack ? INFRA_COLOR : PROJECT_COLOR;
    addObject({ key: `station:${s.node}`, x: s.x, z: s.z, node: s.node, color, label: s.label, build: () => (rack ? makeRack(color) : makeWorkstation(color, i % 3)), ringRadius: rack ? 1.7 : 2.1, labelClass: rack ? "rack" : "project" });
  });

  // ---- avatars: one per desk, starting seated ----
  const STATE_WORDS = { idle: "idle", working: "working", waiting: "needs you", done: "done", collaborating: "pairing" };
  const avatars = layout.desks.map((d) => {
    const def = OFFICE_AGENTS.find((a) => a.id === d.agent);
    const a = makeAvatar(def);
    a.pos = { ...d.stand };
    a.heading = Math.PI;
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
    a.id = `avatar:${d.agent}`;
    return a;
  });

  // ---- a few motes of light drifting in the air above the floor ----
  const MOTES = 170;
  const motePos = new Float32Array(MOTES * 3);
  const moteSpeed = new Float32Array(MOTES);
  const moteColor = new Float32Array(MOTES * 3);
  const palette = [new THREE.Color("#8fb4ff"), new THREE.Color("#2fd4e8"), new THREE.Color("#ff79c6"), new THREE.Color("#ffd9b0")];
  for (let i = 0; i < MOTES; i++) {
    motePos.set([minX + Math.random() * width, 0.5 + Math.random() * 9, minZ + Math.random() * depth], i * 3);
    moteSpeed[i] = 0.08 + Math.random() * 0.22;
    palette[i % palette.length].toArray(moteColor, i * 3);
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute("position", new THREE.BufferAttribute(motePos, 3));
  moteGeo.setAttribute("color", new THREE.BufferAttribute(moteColor, 3));
  const motes = new THREE.Points(moteGeo, new THREE.PointsMaterial({ size: 0.16, map: dotTexture(), vertexColors: true, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }));
  motes.frustumCulled = false;
  scene.add(motes);

  // ---------- camera ----------

  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -200, 400);
  const view = { az: DEFAULT_AZIMUTH, el: DEFAULT_ELEVATION, zoom: 1, target: new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2), goal: null };
  let w = 1;
  let h = 1;
  // Metres visible top to bottom at zoom 1: the whole room (less its empty margin) fits on
  // any window shape, seen from the default angle.
  const baseSize = () => {
    const room = (width + depth - 4) * Math.SQRT1_2;
    return Math.max(room * Math.sin(DEFAULT_ELEVATION) + 9, room / (w / h));
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
      const hit = pick(ev);
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
  function pick(ev) {
    const r = el.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
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
  const hover = (ev) => setHover(pick(ev));

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
      const step = REDUCED ? { pos: st.target, arrived: true, heading: a.heading } : stepToward(a.pos, st.target, WALK_SPEED * dt);
      a.pos = { ...step.pos };
      a.walking = !step.arrived;
      if (a.walking) a.heading = turn(a.heading, step.heading, dt * 10);
      else {
        const at = objects.get(st.key);
        if (at) a.heading = turn(a.heading, Math.atan2(at.x - a.pos.x, at.z - a.pos.z), dt * 8);
      }
      animate(a, st, sec);
      a.group.position.set(a.pos.x, 0, a.pos.z);
      a.group.rotation.y = a.heading;
      const free = a.def.reserved && st.mode === "idle";
      for (const m of a.materials) {
        m.transparent = free;
        m.opacity = free ? 0.35 : 1;
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
      a.pad.rotation.y = sec * 0.8;
    }
    placeTags();

    if (!REDUCED) {
      for (const l of leds) l.mat.emissiveIntensity = 0.5 + 1.9 * (0.5 + 0.5 * Math.sin(sec * l.speed * 3 + l.phase)) ** 2;
      const p = moteGeo.attributes.position;
      for (let i = 0; i < MOTES; i++) {
        let y = p.getY(i) + moteSpeed[i] * dt;
        if (y > 10) y = 0.5;
        p.setY(i, y);
        p.setX(i, p.getX(i) + Math.sin(sec * 0.3 + i) * dt * 0.12);
      }
      p.needsUpdate = true;
    }

    for (const o of objects.values()) {
      const want = o.active ? 0.85 : o.key === selectedKey ? 0.6 : o.hover ? 0.4 : 0;
      o.glow += (want - o.glow) * Math.min(1, dt * 8);
      o.ring.material.opacity = o.glow;
      o.ring.material.color.set(o.active ?? ACCENT);
      o.ring.visible = o.glow > 0.01;
      o.text.classList.toggle("hot", o.hover || o.key === selectedKey || Boolean(o.active));
      placeLabel(o.text, o.x, 0.05, o.z + (o.key.startsWith("desk:") ? -1.2 : 1.1), 14);
    }
    for (const z of zoneLabels) placeLabel(z.el, z.x, 0.1, z.z);
    renderer.render(scene, camera);
  }

  // Names and bubbles over the avatars. Agents that gather at one station would pile their
  // bubbles on top of each other, so from the lowest on screen up, each is lifted above any
  // tag it overlaps. All measuring comes first, then all writing: one layout per frame.
  function placeTags() {
    const tags = avatars.map((a) => {
      tmp.set(a.pos.x, 2.6, a.pos.z).project(camera);
      const { width: tw, height: th } = a.tag.getBoundingClientRect();
      return { a, tw, th, x: (tmp.x * 0.5 + 0.5) * w, y: (-tmp.y * 0.5 + 0.5) * h, inView: tmp.z < 1 && Math.abs(tmp.x) < 1.15 && Math.abs(tmp.y) < 1.15 };
    }).sort((p, q) => q.y - p.y);
    const placed = [];
    const clash = (t) => placed.find((p) => Math.abs(t.x - p.x) < (t.tw + p.tw) / 2 + 4 && t.y > p.y - p.th - 4 && t.y - t.th < p.y + 4);
    const TOP = 60; // below the top bar
    for (const t of tags.filter((x) => x.inView)) {
      const home = t.y;
      for (let pass = 0, hit; pass < tags.length && (hit = clash(t)); pass++) t.y = hit.y - hit.th - 4;
      if (t.y - t.th < TOP && t.y !== home) { // no room above: stack downwards instead
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

  // Walking swings the arms, working types, waiting waves a hand, idle breathes.
  function animate(a, st, sec) {
    const [left, right] = a.arms;
    const k = a.def.agent.length; // so the agents do not move in lockstep
    let bob = 0;
    left.rotation.set(0, 0, 0);
    right.rotation.set(0, 0, 0);
    a.head.rotation.set(0, 0, 0);
    if (REDUCED) return void ((a.body.position.y = BODY_Y), (a.head.position.y = HEAD_Y));
    if (a.walking) {
      bob = Math.abs(Math.sin(sec * 9 + k)) * 0.09;
      left.rotation.x = Math.sin(sec * 9 + k) * 0.7;
      right.rotation.x = -Math.sin(sec * 9 + k) * 0.7;
    } else if (st.mode === "working" || st.mode === "collaborating") {
      left.rotation.x = -1.2 + Math.sin(sec * 17 + k) * 0.22;
      right.rotation.x = -1.2 + Math.sin(sec * 17 + k + 2) * 0.22;
      a.head.rotation.y = st.mode === "collaborating" ? Math.sin(sec * 1.6 + k) * 0.5 : 0;
    } else if (st.mode === "done") {
      bob = Math.abs(Math.sin(sec * 5 + k)) * 0.08; // a little hop: the task is finished
    } else if (st.mode === "waiting") {
      right.rotation.z = -2.7 + Math.sin(sec * 7) * 0.25;
      bob = Math.abs(Math.sin(sec * 4)) * 0.12;
    } else {
      bob = Math.sin(sec * 1.6 + k) * 0.015;
    }
    a.body.position.y = BODY_Y + bob;
    a.head.position.y = HEAD_Y + bob + Math.sin(sec * 2 + k) * 0.03; // the head floats a little above the body
  }

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
    // Highlight the desk or station that stands for a node, and fly the camera to it.
    select(id) {
      const place = id ? locator.resolve(id) : null;
      selectedKey = place?.key ?? null;
      const o = selectedKey && objects.get(selectedKey);
      if (o) view.goal = { x: o.x, z: o.z };
    },
    layout,
  };
}
