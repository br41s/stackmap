// The 3D office: an isometric diorama of the stack. Agents sit at their desks and walk to the
// project or infrastructure station a signal names, with a speech bubble of what they report.
// Everything that decides *where* lives in office-layout.js (pure, tested); this file only
// draws it with plain three.js — procedural shapes, no models, no build step. Loaded on demand
// by app.js, so the map never pays for three.js until the office is opened.
// Names and bubbles are DOM elements positioned over the canvas: sharp text, selectable by
// screen readers, no texture atlas. The frame loop runs only while the office is on screen.
import * as THREE from "/vendor/three.module.js";
import { OFFICE_AGENTS, createLocator, layoutOffice, officeStates, pushSignal, stepToward } from "./office-layout.js";

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const WALK_SPEED = 3.2; // metres per second
const ACCENT = "#6aa8ff";
const PROJECT_COLOR = "#38d989"; // layer-products
const INFRA_COLOR = "#5b9dff";   // layer-hosting
const DEFAULT_AZIMUTH = Math.PI / 4;
const DEFAULT_ELEVATION = 0.62;

const lambert = (color, { emissive = 0, glow = 0.8, rough = 0.7, metal = 0.1 } = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, emissive: emissive || 0x000000, emissiveIntensity: emissive ? glow : 0 });
const box = (w, h, d, material, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  return m;
};

// ---------- things in the room ----------

function makeDesk(color, reserved) {
  const g = new THREE.Group();
  const wood = lambert("#141b33");
  const screen = lambert("#0a0f1e", { emissive: color, glow: reserved ? 0.12 : 0.85 });
  g.add(box(3.4, 0.14, 1.7, wood, 0, 0.8, 0));
  g.add(box(0.14, 0.8, 1.5, wood, -1.55, 0.4, 0), box(0.14, 0.8, 1.5, wood, 1.55, 0.4, 0));
  g.add(box(1.5, 0.9, 0.08, screen, 0, 1.45, -0.35), box(0.12, 0.35, 0.12, wood, 0, 1.0, -0.35));
  g.add(box(1.0, 0.04, 0.3, lambert("#1d2748"), 0, 0.89, 0.3));
  const chair = new THREE.Group();
  chair.add(box(0.8, 0.12, 0.8, lambert("#10172b"), 0, 0.5, 0), box(0.8, 0.8, 0.1, lambert("#10172b"), 0, 0.95, 0.4));
  chair.position.z = 1.5;
  g.add(chair);
  return g;
}

function makeWorkstation(color) {
  const g = new THREE.Group();
  const wood = lambert("#141b33");
  g.add(box(2.4, 0.12, 1.3, wood, 0, 0.7, 0));
  g.add(box(0.12, 0.7, 1.1, wood, -1.1, 0.35, 0), box(0.12, 0.7, 1.1, wood, 1.1, 0.35, 0));
  g.add(box(1.3, 0.8, 0.07, lambert("#0a0f1e", { emissive: color, glow: 0.7 }), 0, 1.25, -0.25));
  g.add(box(0.1, 0.3, 0.1, wood, 0, 0.88, -0.25));
  return g;
}

function makeRack(color) {
  const g = new THREE.Group();
  g.add(box(1.5, 2.6, 1.1, lambert("#0e1428", { metal: 0.5, rough: 0.4 }), 0, 1.3, 0));
  const led = lambert("#06101f", { emissive: color, glow: 1.1 });
  for (let i = 0; i < 5; i++) g.add(box(1.2, 0.07, 0.04, led, 0, 0.5 + i * 0.45, 0.57));
  return g;
}

// A glowing ring on the floor under a desk or station: hover, selection and "someone is working here".
function makeRing(radius) {
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius * 0.86, radius, 48), new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  return ring;
}

// ---------- avatars ----------

// Each agent has its own silhouette so they read apart from far away.
function makeAvatar(agent) {
  const g = new THREE.Group();
  const body = lambert(agent.color, { emissive: agent.color, glow: 0.18 });
  const dark = lambert("#0a0f1e", { emissive: agent.color, glow: 0.9 });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.55, 4, 12), body);
  torso.position.y = 0.85;
  g.add(torso);
  const head = new THREE.Group();
  head.position.y = 1.62;
  g.add(head);
  const sphere = (r, m = body) => new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), m);
  switch (agent.id) {
    case "claude-code": // a boxy head with a lit visor
      head.add(box(0.55, 0.48, 0.5, body), box(0.5, 0.14, 0.05, dark, 0, 0.04, 0.26));
      break;
    case "hermes": { // a round head with wings at the temples
      head.add(sphere(0.3));
      for (const s of [-1, 1]) {
        const wing = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.45, 4), dark);
        wing.position.set(s * 0.36, 0.1, 0);
        wing.rotation.z = -s * 1.1;
        head.add(wing);
      }
      break;
    }
    case "buzz": { // antennae, and a stripe round the belly
      head.add(sphere(0.29));
      for (const s of [-1, 1]) {
        const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.34, 6), dark);
        stalk.position.set(s * 0.1, 0.4, 0);
        stalk.rotation.z = -s * 0.35;
        const tip = sphere(0.055, dark);
        tip.position.set(s * 0.17, 0.57, 0);
        head.add(stalk, tip);
      }
      const stripe = new THREE.Mesh(new THREE.TorusGeometry(0.31, 0.04, 8, 24), dark);
      stripe.rotation.x = Math.PI / 2;
      stripe.position.y = 0.85;
      g.add(stripe);
      break;
    }
    case "gemini": { // twin heads
      for (const s of [-1, 1]) {
        const h = sphere(0.21);
        h.position.set(s * 0.17, 0, 0);
        head.add(h);
      }
      break;
    }
    case "chatgpt": { // a round head with a halo
      head.add(sphere(0.3));
      const halo = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.035, 8, 28), dark);
      halo.rotation.x = Math.PI / 2;
      halo.position.y = 0.46;
      head.add(halo);
      break;
    }
    default:
      head.add(sphere(0.3));
  }
  // Arms hang from the shoulders and swing from there.
  const arms = [-1, 1].map((s) => {
    const pivot = new THREE.Group();
    pivot.position.set(s * 0.38, 1.2, 0);
    const arm = box(0.12, 0.5, 0.12, body, 0, -0.22, 0);
    pivot.add(arm);
    g.add(pivot);
    return pivot;
  });
  return { group: g, head, arms, materials: [body, dark] };
}

// ---------- the office ----------

export function createOffice(container, { stack, signals = [], hold, onPick = () => {} }) {
  const layout = layoutOffice(stack);
  const locator = createLocator(stack, layout);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.className = "office-canvas";
  container.append(renderer.domElement);
  const labels = document.createElement("div");
  labels.className = "office-labels";
  const hint = document.createElement("div");
  hint.className = "office-hint";
  hint.textContent = "drag: rotate · right-drag: pan · wheel: zoom · click a desk or station";
  container.append(labels, hint);

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0x7080c0, 0.7));
  const sun = new THREE.DirectionalLight(0xa9bcff, 1.0);
  sun.position.set(-18, 30, 14);
  scene.add(sun);
  const cyan = new THREE.PointLight(0x2fd4e8, 60, 40);
  cyan.position.set(0, 7, layout.bounds.minZ + 4);
  const magenta = new THREE.PointLight(0xff79c6, 50, 40);
  magenta.position.set(0, 7, layout.bounds.maxZ - 3);
  scene.add(cyan, magenta);

  const { minX, maxX, minZ, maxZ } = layout.bounds;
  const width = maxX - minX;
  const depth = maxZ - minZ;
  const floor = new THREE.Mesh(new THREE.BoxGeometry(width, 0.4, depth), lambert("#0a1022", { rough: 0.85 }));
  floor.position.set((minX + maxX) / 2, -0.2, (minZ + maxZ) / 2);
  scene.add(floor);
  const grid = new THREE.GridHelper(Math.max(width, depth), Math.round(Math.max(width, depth) / 2), 0x3b5bb0, 0x1a2a5c);
  grid.position.set(floor.position.x, 0.01, floor.position.z);
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  scene.add(grid);

  // Everything clickable, by the key officeStates() uses for "where" (station:<id> / desk:<agent>).
  const objects = new Map();
  const pickables = [];
  const addObject = ({ key, x, z, node, color, label, build, ringRadius, labelClass }) => {
    const group = build();
    group.position.set(x, 0, z);
    scene.add(group);
    const ring = makeRing(ringRadius);
    ring.position.set(x, 0.03, z);
    scene.add(ring);
    const hit = box(3.6, 2.6, 2.4, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }), 0, 1.3, 0);
    group.add(hit);
    pickables.push(hit);
    const text = document.createElement("div");
    text.className = `office-label ${labelClass}`;
    text.style.setProperty("--tag", color);
    text.textContent = label;
    labels.append(text);
    objects.set(key, { key, x, z, node, color, ring, text, glow: 0, hover: false, active: null });
    hit.userData.key = key;
  };
  for (const d of layout.desks) {
    addObject({ key: `desk:${d.agent}`, x: d.x, z: d.z, node: d.node, color: d.color, label: `${d.label}${d.reserved ? " · free desk" : ""}`, build: () => makeDesk(d.color, d.reserved), ringRadius: 2.6, labelClass: "desk" });
  }
  for (const s of layout.stations) {
    const rack = s.zone === "infra";
    const color = rack ? INFRA_COLOR : PROJECT_COLOR;
    addObject({ key: `station:${s.node}`, x: s.x, z: s.z, node: s.node, color, label: s.label, build: () => (rack ? makeRack(color) : makeWorkstation(color)), ringRadius: rack ? 1.6 : 2.0, labelClass: rack ? "rack" : "project" });
  }

  // Avatars: one per desk, starting seated.
  const avatars = layout.desks.map((d) => {
    const def = OFFICE_AGENTS.find((a) => a.id === d.agent);
    const a = makeAvatar(def);
    a.pos = { ...d.stand };
    a.heading = Math.PI;
    a.walking = false;
    a.def = d;
    a.group.position.set(a.pos.x, 0, a.pos.z);
    scene.add(a.group);
    const tag = document.createElement("div");
    tag.className = "office-tag";
    tag.style.setProperty("--tag", d.color);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = d.label;
    const bubble = document.createElement("span");
    bubble.className = "bubble";
    bubble.hidden = true;
    tag.append(name, bubble);
    labels.append(tag);
    a.tag = tag;
    a.bubble = bubble;
    a.id = `avatar:${d.agent}`;
    return a;
  });

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

  function placeLabel(node, x, y, z, dy = 0) {
    tmp.set(x, y, z).project(camera);
    const inView = tmp.z < 1 && Math.abs(tmp.x) < 1.15 && Math.abs(tmp.y) < 1.15;
    node.style.visibility = inView ? "visible" : "hidden";
    if (inView) node.style.transform = `translate(${((tmp.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-tmp.y * 0.5 + 0.5) * h + dy).toFixed(1)}px) translate(-50%, -100%)`;
  }

  function frame(t) {
    raf = requestAnimationFrame(frame);
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
    }
    placeTags();

    for (const o of objects.values()) {
      const want = o.active ? 0.85 : o.key === selectedKey ? 0.6 : o.hover ? 0.4 : 0;
      o.glow += (want - o.glow) * Math.min(1, dt * 8);
      o.ring.material.opacity = o.glow;
      o.ring.material.color.set(o.active ?? ACCENT);
      o.ring.visible = o.glow > 0.01;
      o.text.classList.toggle("hot", o.hover || o.key === selectedKey || Boolean(o.active));
      placeLabel(o.text, o.x, 0.05, o.z + (o.key.startsWith("desk:") ? -1.2 : 1.1), 14);
    }
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
    if (REDUCED) return void (a.group.children[0].position.y = 0.85);
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
    a.group.children[0].position.y = 0.85 + bob;
    a.head.position.y = 1.62 + bob;
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
