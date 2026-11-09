// The 3D office, drawn as a living little village on a floating island: pastel houses for the
// agents, shops and workshops for the projects and their services, silos and lighthouses for the
// hosting platforms, a river with bridges and a waterfall, mountains along the north, trees,
// flowers, birds. The sky follows Bangkok — the sun is where it really is, the weather is what
// Bangkok has this hour (or whatever you pick) — and the little characters walk along the roads
// to the building a signal names, type there, and say what they are doing in a speech bubble.
// Everything that decides *where* (layout, roads, who is where) is pure and tested: see
// office-layout.js, village.js and sky.js. The pieces are in office-parts.js and
// office-world.js; this file puts them together, runs the sky and the camera, and draws a frame.
// All procedural three.js: no models, no image files, no build step, no post-processing add-ons
// (they would need an import map, which the CSP forbids). Loaded on demand by app.js, so the map
// never pays for three.js until the office is opened. The frame loop stops completely while the
// office is hidden or the tab is in the background, and slows down while the window is unfocused.
import * as THREE from "/vendor/three.module.js";
import { OFFICE_AGENTS, createLocator, layoutOffice, officeStates, pushSignal, routeBetween, stepToward } from "./office-layout.js";
import { atBangkokHour, bangkokClock, mix, skyState, sunPosition } from "./sky.js";
import { PALETTE, bake, dotTexture, lampMat, makeAvatar, makeBird, makeBuilding, makeCloud, mat, shadowed } from "./office-parts.js";
import { buildWorld } from "./office-world.js";
import { rng } from "./village.js";

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const WALK_SPEED = 3.2; // metres per second
const BLUR_FPS = 12;    // frame rate while the window is unfocused but still visible; 0 pauses it
const DEFAULT_AZIMUTH = Math.PI / 4;
const DEFAULT_ELEVATION = 0.62;
const MIN_ELEVATION = 0.22;
const MAX_ELEVATION = 1.35;
const MIN_ZOOM = 0.7;
const MAX_ZOOM = 16;
const HOME_ZOOM = 2.1;
const SELECT_COLOR = "#ff7a59";
const DEG = 180 / Math.PI;

// The weather a person can pick by hand, in place of Bangkok's.
const PRESETS = {
  clear: { cloud: 0.08, rain: 0, condition: "clear" },
  partly: { cloud: 0.45, rain: 0, condition: "partly" },
  cloudy: { cloud: 0.92, rain: 0, condition: "cloudy" },
  fog: { cloud: 0.8, rain: 0, condition: "fog" },
  rain: { cloud: 0.95, rain: 0.7, condition: "rain" },
  storm: { cloud: 1, rain: 1, condition: "storm" },
};
const CONDITION_ICON = { clear: "☀", partly: "⛅", cloudy: "☁", fog: "≋", drizzle: "☂", rain: "☂", storm: "⚡", snow: "❄" };
const CONDITION_WORD = { clear: "clear", partly: "partly cloudy", cloudy: "overcast", fog: "fog", drizzle: "drizzle", rain: "rain", storm: "thunderstorm", snow: "snow" };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

export function createOffice(container, { stack, signals = [], hold, onPick = () => {} }) {
  const layout = layoutOffice(stack);
  const locator = createLocator(stack, layout);
  const { terrain } = layout;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // three 0.187 removed PCFSoftShadowMap: this one is soft now
  renderer.domElement.className = "office-canvas";

  // ---------- page furniture: sky layers, labels, the control bar ----------
  const stars = el("div", "office-stars");
  const body = el("div", "office-body"); // the sun by day, the moon by night
  const flash = el("div", "office-flash");
  const labels = el("div", "office-labels");
  container.append(stars, body, renderer.domElement, flash, labels);

  const bar = el("div", "office-bar");
  const nav = el("div", "office-nav");
  const navButton = (text, title, onClick) => {
    const b = el("button", null, text);
    b.type = "button";
    b.title = title;
    b.addEventListener("click", onClick);
    nav.append(b);
    return b;
  };
  const skyChip = el("button", "office-skychip");
  skyChip.type = "button";
  skyChip.title = "Sky: Bangkok's real time and weather, or pick your own";
  const followChip = el("button", "office-follow", "");
  followChip.type = "button";
  followChip.hidden = true;
  const demoButton = el("button", "office-demo", "▶ Demo");
  demoButton.type = "button";
  demoButton.title = "Play a few made-up signals to see the agents work (nothing is sent anywhere)";
  const hint = el("span", "office-hint", "drag: move · right-drag: turn · wheel: zoom · double-click: go there · WASD / Q E: fly");
  bar.append(nav, skyChip, followChip, demoButton, hint);

  const panel = el("div", "office-panel");
  panel.hidden = true;
  const panelHead = el("div", "panel-head", "Sky over the village");
  const modeRow = el("div", "panel-row");
  const liveButton = el("button", "on", "Live · Bangkok");
  const manualButton = el("button", null, "Pick a time");
  liveButton.type = manualButton.type = "button";
  modeRow.append(liveButton, manualButton);
  const hourRow = el("label", "panel-row");
  const hourText = el("span", "panel-label", "Hour");
  const hourInput = el("input");
  hourInput.type = "range";
  hourInput.min = "0";
  hourInput.max = "24";
  hourInput.step = "0.25";
  hourRow.append(hourText, hourInput);
  const weatherRow = el("label", "panel-row");
  const weatherText = el("span", "panel-label", "Weather");
  const weatherSelect = el("select");
  for (const [value, text] of [["live", "Bangkok's right now"], ["clear", "Clear"], ["partly", "Partly cloudy"], ["cloudy", "Overcast"], ["fog", "Fog"], ["rain", "Rain"], ["storm", "Thunderstorm"]]) {
    const o = el("option", null, text);
    o.value = value;
    weatherSelect.append(o);
  }
  weatherRow.append(weatherText, weatherSelect);
  const panelInfo = el("div", "panel-info");
  panel.append(panelHead, modeRow, hourRow, weatherRow, panelInfo);
  container.append(bar, panel);

  // ---------- scene, light ----------
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xffffff, 0);
  const hemi = new THREE.HemisphereLight(0xcfe6ff, 0xf3dcb5, 0.95);
  const ambient = new THREE.AmbientLight(0xfff0e0, 0.35);
  const sun = new THREE.DirectionalLight(0xfff0d2, 2.1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.04;
  scene.add(hemi, ambient, sun, sun.target);

  const { minX, maxX, minZ, maxZ } = layout.bounds;
  const width = maxX - minX;
  const depth = maxZ - minZ;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;

  // ---------- the world: land, river, mountains, roads, scenery ----------
  const world = buildWorld({ scene, layout, renderer });

  // ---------- buildings, one per house / shop / silo ----------
  const town = new THREE.Group();
  scene.add(town);
  const objects = new Map();
  const pickables = [];
  const addObject = ({ key, x, z, rot, scale, node, color, label, built, hitSize, ringRadius, tier, stand }) => {
    const wrap = new THREE.Group();
    wrap.position.set(x, 0, z);
    wrap.rotation.y = rot;
    built.group.scale.setScalar(scale);
    wrap.add(built.group);
    town.add(wrap);
    const ring = new THREE.Mesh(new THREE.RingGeometry(ringRadius * 0.9, ringRadius, 56), new THREE.MeshBasicMaterial({ color: SELECT_COLOR, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.1, z);
    scene.add(ring);
    const hit = new THREE.Mesh(new THREE.BoxGeometry(hitSize.w * scale, hitSize.h * scale, hitSize.d * scale), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    hit.position.y = (hitSize.h * scale) / 2;
    hit.userData.keep = true; // the click box is not part of the baked scenery
    wrap.add(hit);
    hit.userData.key = key;
    pickables.push(hit);
    const gear = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.09, 6, 8), mat("#ffd45e", { emissive: "#ffd45e", glow: 0.6, rough: 0.5, unique: true })), { cast: false });
    gear.position.y = built.top * scale + 0.7;
    gear.visible = false;
    gear.userData.keep = true;
    wrap.add(gear);
    const text = el("div", `office-label tier${tier}`, label);
    text.style.setProperty("--tag", color);
    text.hidden = true;
    labels.append(text);
    objects.set(key, { key, x, z, node, color, ring, text, glass: built.glass, gear, gearY: gear.position.y, sails: built.sails, tier, stand, glow: 0, lit: 0.3, hover: false, active: null, labelOn: false });
  };
  for (const d of layout.desks) {
    addObject({ key: `desk:${d.agent}`, x: d.x, z: d.z, rot: d.rot, scale: d.scale, node: d.node, color: d.color, label: `${d.label}${d.reserved ? " · free house" : ""}`, built: makeBuilding({ style: "home", node: d.agent, color: d.color, free: d.reserved }), hitSize: { w: 4.2, h: 3.4, d: 3 }, ringRadius: 2.9, tier: 0, stand: d.stand });
  }
  layout.stations.forEach((s, i) => {
    const big = s.zone === "project" || s.zone === "platform";
    addObject({
      key: `station:${s.node}`, x: s.x, z: s.z, rot: s.rot, scale: s.scale, node: s.node, color: s.zone === "platform" || s.zone === "hosting" ? "#4a8fe0" : "#2fb56a", label: s.status === "retired" ? `${s.label} · ruins` : s.label,
      built: makeBuilding({ style: s.style, node: s.node, index: i, ruin: s.status === "retired" }), hitSize: { w: 3.6, h: 3.6, d: 3.2 }, ringRadius: s.radius + 0.9, tier: big ? 1 : 2, stand: s.stand,
    });
  });
  for (const mesh of bake(town)) town.add(mesh);
  world.bake();

  // lamp posts have point lights at a few of them, which glow at night
  const lampLights = [];
  const lampSpots = world.lamps.filter((_, i) => i % Math.max(1, Math.floor(world.lamps.length / 9)) === 0).slice(0, 9);
  for (const p of lampSpots) {
    const light = new THREE.PointLight(0xffd9a0, 0, 20, 1.8);
    light.position.set(p.x, 1.7, p.z);
    scene.add(light);
    lampLights.push(light);
  }

  // ---------- characters ----------
  const STATE_WORDS = { idle: "idle", working: "working", waiting: "needs you", done: "done", collaborating: "pairing" };
  const avatars = layout.desks.map((d) => {
    const def = OFFICE_AGENTS.find((a) => a.id === d.agent);
    const a = makeAvatar(def);
    a.pos = { x: d.stand.x, z: d.stand.z };
    a.goal = { x: d.stand.x, z: d.stand.z };
    a.path = [];
    a.heading = d.rot;
    a.walking = false;
    a.def = d;
    a.mode = "idle";
    a.group.position.set(a.pos.x, 0, a.pos.z);
    scene.add(a.group);
    const hit = new THREE.Mesh(new THREE.SphereGeometry(0.85, 10, 8), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    hit.position.y = 0.9;
    hit.userData.avatar = a;
    a.group.add(hit);
    pickables.push(hit);
    const tag = el("div", "office-tag");
    tag.style.setProperty("--tag", d.color);
    const name = el("span", "name");
    const nameText = el("b", null, d.label);
    const state = el("em", null, STATE_WORDS.idle);
    name.append(el("i"), nameText, state);
    const bubble = el("span", "bubble");
    bubble.hidden = true;
    tag.append(name, bubble);
    labels.append(tag);
    a.tag = tag;
    a.bubble = bubble;
    a.stateEl = state;
    return a;
  });

  // ---------- weather and sky life: clouds, rain, birds, fireflies ----------
  const r = rng(909);
  const clouds = [];
  for (let i = 0; i < 30; i++) {
    const c = makeCloud(r);
    const low = i < 9; // these float below the island; the rest drift high above it and come and go with the weather
    c.position.set(minX - 14 + r() * (width + 28), low ? -5 - r() * 7 : 34 + r() * 10, minZ - 10 + r() * (depth + 20));
    c.scale.setScalar(low ? 1 + r() * 1.2 : 0.7 + r() * 0.7);
    scene.add(c);
    clouds.push({ c, low, show: low, speed: 0.2 + r() * 0.35, rank: low ? -1 : i - 9 });
  }
  const RAIN = 1600;
  const rainPos = new Float32Array(RAIN * 6);
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute("position", new THREE.BufferAttribute(rainPos, 3));
  const rainLines = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0xcfe6ff, transparent: true, opacity: 0.55, depthWrite: false }));
  rainLines.frustumCulled = false;
  rainLines.visible = false;
  scene.add(rainLines);
  const rainSeed = Array.from({ length: RAIN }, () => [r(), r(), r(), 24 + r() * 10]);
  const flocks = [];
  for (let f = 0; f < 4; f++) {
    const birds = Array.from({ length: 4 + (f % 2) }, (_, i) => {
      const b = makeBird(f % 2 ? "#fffaf0" : "#8b7766");
      b.scale.setScalar(1.3);
      scene.add(b);
      return { b, lag: i * 0.045, side: (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.9 };
    });
    flocks.push({ birds, radius: 18 + f * 9, speed: (f % 2 ? 1 : -1) * (0.1 + f * 0.02), phase: r() * 6.28, height: 9 + f * 1.6, cx: cx + (r() - 0.5) * 20, cz: cz + (r() - 0.5) * 16 });
  }
  const MOTES = 150;
  const motePos = new Float32Array(MOTES * 3);
  const moteSpeed = new Float32Array(MOTES);
  for (let i = 0; i < MOTES; i++) {
    motePos.set([minX + r() * width, 0.5 + r() * 6, minZ + r() * depth], i * 3);
    moteSpeed[i] = 0.05 + r() * 0.14;
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute("position", new THREE.BufferAttribute(motePos, 3));
  const motes = new THREE.Points(moteGeo, new THREE.PointsMaterial({ size: 0.17, map: dotTexture(), color: 0xfff6c9, transparent: true, opacity: 0.7, depthWrite: false }));
  motes.frustumCulled = false;
  scene.add(motes);

  // ---------- camera ----------
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -300, 500);
  const home = { x: terrain.plaza.x, z: terrain.plaza.z + 4 };
  const view = { az: DEFAULT_AZIMUTH, el: DEFAULT_ELEVATION, zoom: HOME_ZOOM, target: new THREE.Vector3(home.x, 0, home.z) };
  const goal = { az: view.az, el: view.el, zoom: view.zoom, target: view.target.clone() };
  let w = 1;
  let h = 1;
  let follow = null;
  // Metres visible top to bottom at zoom 1: the whole island, from the default angle.
  const baseSize = () => {
    const room = (width + depth) * Math.SQRT1_2 * 0.88;
    return Math.max(room * Math.sin(DEFAULT_ELEVATION) + 14, room / (w / h));
  };
  const visibleHalf = () => baseSize() / view.zoom / 2;

  function placeCamera() {
    const half = visibleHalf();
    camera.left = -half * (w / h);
    camera.right = half * (w / h);
    camera.top = half;
    camera.bottom = -half;
    camera.updateProjectionMatrix();
    const d = 120;
    camera.position.set(view.target.x + Math.sin(view.az) * Math.cos(view.el) * d, view.target.y + Math.sin(view.el) * d, view.target.z + Math.cos(view.az) * Math.cos(view.el) * d);
    camera.lookAt(view.target);
    camera.updateMatrixWorld(true);
    // the shadows follow what is on screen, so they stay sharp however far in you are
    const reach = clamp(half * Math.max(w / h, 1) * 1.25, 16, 90);
    Object.assign(sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 1, far: 220 });
    sun.shadow.camera.updateProjectionMatrix();
    placeSun();
  }
  function resize() {
    w = Math.max(container.clientWidth, 1);
    h = Math.max(container.clientHeight, 1);
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = `${w}px`;
    renderer.domElement.style.height = `${h}px`;
    placeCamera();
  }

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitPoint = new THREE.Vector3();
  // The spot on the ground under a screen point.
  function groundAt(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.ray.intersectPlane(ground, hitPoint) ? hitPoint.clone() : null;
  }
  const clampTarget = (t) => {
    t.x = clamp(t.x, minX, maxX);
    t.z = clamp(t.z, minZ, maxZ);
  };
  const syncGoal = () => {
    goal.az = view.az;
    goal.el = view.el;
    goal.zoom = view.zoom;
    goal.target.copy(view.target);
  };
  // Zoom keeping the ground point under the cursor where it is.
  function zoomAt(clientX, clientY, factor) {
    const before = groundAt(clientX, clientY);
    view.zoom = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    placeCamera();
    const after = groundAt(clientX, clientY);
    if (before && after) {
      view.target.x += before.x - after.x;
      view.target.z += before.z - after.z;
      clampTarget(view.target);
      placeCamera();
    }
    syncGoal();
  }
  function flyTo(x, z, zoom = view.zoom) {
    follow = null;
    followChip.hidden = true;
    goal.target.set(x, 0, z);
    clampTarget(goal.target);
    goal.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  }
  const goHome = () => { goal.az = DEFAULT_AZIMUTH; goal.el = DEFAULT_ELEVATION; flyTo(home.x, home.z, HOME_ZOOM); };
  const fitAll = () => { goal.az = DEFAULT_AZIMUTH; goal.el = DEFAULT_ELEVATION; flyTo(cx, cz, 1); };
  const turnBy = (d) => { goal.az += d; };
  navButton("⟲", "Turn left (Q)", () => turnBy(-Math.PI / 8));
  navButton("⟳", "Turn right (E)", () => turnBy(Math.PI / 8));
  navButton("−", "Zoom out (-)", () => { goal.zoom = clamp(goal.zoom / 1.5, MIN_ZOOM, MAX_ZOOM); });
  navButton("+", "Zoom in (+)", () => { goal.zoom = clamp(goal.zoom * 1.5, MIN_ZOOM, MAX_ZOOM); });
  navButton("⌂", "Back to the plaza (Home)", goHome);
  navButton("⤢", "See the whole island (F)", fitAll);
  const setFollow = (a) => {
    follow = a;
    followChip.hidden = !a;
    if (a) {
      followChip.textContent = `Following ${a.def.label} ✕`;
      goal.zoom = Math.max(goal.zoom, 4);
    }
  };
  followChip.addEventListener("click", () => setFollow(null));

  // ---------- pointer, touch and keyboard ----------
  const canvas = renderer.domElement;
  const pointers = new Map();
  const drag = { mode: null, moved: 0, g0: null, x: 0, y: 0 };
  const pinch = { dist: 0, angle: 0, cx: 0, cy: 0 };
  const twoFingers = () => {
    const [a, b] = [...pointers.values()];
    return { dist: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  };
  canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());
  canvas.addEventListener("pointerdown", (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.size === 2) {
      Object.assign(pinch, twoFingers());
      drag.mode = "pinch";
      return;
    }
    drag.moved = 0;
    drag.x = ev.clientX;
    drag.y = ev.clientY;
    drag.mode = ev.button === 0 && !ev.ctrlKey && !ev.altKey ? "pan" : "turn";
    drag.g0 = drag.mode === "pan" ? groundAt(ev.clientX, ev.clientY) : null;
    syncGoal();
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!pointers.has(ev.pointerId)) return void setHover(pick3d(ev));
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (drag.mode === "pinch" && pointers.size === 2) {
      const now = twoFingers();
      const before = groundAt(pinch.cx, pinch.cy);
      view.az -= now.angle - pinch.angle;
      view.zoom = clamp(view.zoom * (now.dist / Math.max(pinch.dist, 1)), MIN_ZOOM, MAX_ZOOM);
      placeCamera();
      const after = groundAt(now.cx, now.cy);
      if (before && after) { view.target.x += before.x - after.x; view.target.z += before.z - after.z; clampTarget(view.target); }
      Object.assign(pinch, now);
      follow = null;
      followChip.hidden = true;
      placeCamera();
      syncGoal();
      return;
    }
    if (!drag.mode || drag.mode === "pinch") return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    drag.x = ev.clientX;
    drag.y = ev.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    if (drag.mode === "turn") {
      view.az += dx * 0.006;
      view.el = clamp(view.el + dy * 0.004, MIN_ELEVATION, MAX_ELEVATION);
    } else if (drag.moved >= 4 && drag.g0) {
      const g = groundAt(ev.clientX, ev.clientY); // grab the ground: what was under the finger stays under it
      if (g) { view.target.x += drag.g0.x - g.x; view.target.z += drag.g0.z - g.z; clampTarget(view.target); }
      follow = null;
      followChip.hidden = true;
    }
    placeCamera();
    syncGoal();
  });
  const release = (ev) => {
    const wasPinch = drag.mode === "pinch";
    pointers.delete(ev.pointerId);
    if (wasPinch) { drag.mode = pointers.size ? "pan" : null; return; }
    const click = drag.mode && drag.moved < 5;
    drag.mode = null;
    if (click && ev.type === "pointerup") {
      const hit = pick3d(ev);
      if (hit?.avatar) { setFollow(follow === hit.avatar ? null : hit.avatar); if (hit.avatar.def.node) onPick(hit.avatar.def.node); }
      else if (hit?.node) onPick(hit.node);
    }
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("pointerleave", () => setHover(null));
  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    zoomAt(ev.clientX, ev.clientY, Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0014)));
  }, { passive: false });
  canvas.addEventListener("dblclick", (ev) => {
    const hit = pick3d(ev);
    if (hit?.avatar) return void setFollow(hit.avatar);
    if (hit?.node) { onPick(hit.node); flyTo(hit.x, hit.z, Math.max(view.zoom, 5)); return; }
    const g = groundAt(ev.clientX, ev.clientY);
    if (g) flyTo(g.x, g.z, view.zoom * 1.9);
  });

  const keys = new Set();
  const typing = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? "");
  let fast = false; // Shift held: fly faster
  addEventListener("keydown", (ev) => {
    fast = ev.shiftKey;
    if (container.hidden || typing() || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const k = ev.key.toLowerCase();
    if ("wasdqe=+-_".includes(k) && k.length === 1 || k.startsWith("arrow")) { keys.add(k); ev.preventDefault(); }
    else if (k === "home" || k === "0") goHome();
    else if (k === "f") fitAll();
    else if (k === "escape" && follow) setFollow(null);
  });
  addEventListener("keyup", (ev) => { fast = ev.shiftKey; keys.delete(ev.key.toLowerCase()); });
  addEventListener("blur", () => keys.clear());

  // ---------- picking and hover ----------
  function pick3d(ev) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickables, false)[0];
    if (!hit) return null;
    if (hit.object.userData.avatar) return { avatar: hit.object.userData.avatar, node: hit.object.userData.avatar.def.node };
    return objects.get(hit.object.userData.key);
  }
  let hovered = null;
  function setHover(o) {
    if (hovered === o) return;
    if (hovered && !hovered.avatar) hovered.hover = false;
    hovered = o;
    if (o && !o.avatar) o.hover = true;
    canvas.style.cursor = o?.node || o?.avatar ? "pointer" : "";
  }

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

  // ---------- the sky ----------
  const ctl = { live: true, hour: 12, weather: "live", liveWeather: null };
  let sky = skyState({ elevation: 1, weather: {} });
  let skyAt = 0;
  async function readWeather() {
    try {
      const res = await fetch("/api/weather");
      if (res.ok) ctl.liveWeather = (await res.json()).current;
      applySky();
    } catch {}
  }
  readWeather();
  const weatherTimer = setInterval(readWeather, 600_000);
  weatherTimer.unref?.();

  const lightDir = new THREE.Vector3();
  function placeSun() {
    const elev = Math.min(sky.lightElevation, 70 / DEG); // keep a little shadow at noon, as a picture
    lightDir.set(Math.sin(sky.lightAzimuth) * Math.cos(elev), Math.sin(elev), -Math.cos(sky.lightAzimuth) * Math.cos(elev));
    sun.position.copy(view.target).addScaledVector(lightDir, 90);
    sun.target.position.copy(view.target);
  }

  const skyColors = { bottom: new THREE.Color(), tmp: new THREE.Color() };
  let flashLevel = 0;
  let nextFlash = 6;
  function readSky(now = Date.now()) {
    const when = ctl.live ? new Date(now) : atBangkokHour(new Date(now), ctl.hour);
    const weather = ctl.weather !== "live" ? PRESETS[ctl.weather] : ctl.liveWeather ?? PRESETS.clear;
    const sunPos = sunPosition(when);
    return { when, weather, state: skyState({ ...sunPos, weather }), sunPos };
  }
  function applySky(now = Date.now()) {
    const { when, weather, state: s, sunPos } = readSky(now);
    sky = s;
    skyAt = now;
    container.style.setProperty("--sky-top", s.skyTop);
    container.style.setProperty("--sky-bottom", s.skyBottom);
    stars.style.opacity = String(s.stars);
    hemi.color.set(s.hemiSky);
    hemi.groundColor.set(s.hemiGround);
    hemi.intensity = s.hemiPower;
    ambient.intensity = s.ambientPower;
    sun.color.set(s.lightColor);
    sun.intensity = s.lightPower;
    placeSun();
    lampMat.emissiveIntensity = 0.15 + 2.6 * s.lamps;
    for (const l of lampLights) l.intensity = s.lamps * 28;
    skyColors.bottom.set(s.skyBottom);
    scene.fog.color.copy(skyColors.bottom);
    scene.fog.density = s.fog * 0.016;
    renderer.toneMappingExposure = 0.95 + 0.1 * s.day;
    world.water.mesh.material.color.setScalar(0.35 + 0.65 * s.day);
    world.water.mesh.material.emissiveIntensity = 0.1 + 0.15 * s.lamps;
    motes.material.color.set(mix("#fff6c9", "#c8ff8a", s.night));
    motes.material.size = 0.17 + 0.1 * s.night;
    motes.material.opacity = (0.5 + 0.4 * s.night) * (1 - s.rain * 0.8);
    // the sun or the moon, drifting across the sky from east to west
    const high = sunPos.elevation > -0.05;
    const e = high ? sunPos.elevation : s.lightElevation;
    const a = high ? sunPos.azimuth : s.lightAzimuth;
    body.style.left = `${clamp(((a * DEG - 60) / 240) * 100, 4, 96)}%`;
    body.style.top = `${clamp(62 - (e * DEG / 90) * 54, 4, 66)}%`;
    body.classList.toggle("moon", !high);
    body.style.opacity = String(clamp(1 - s.cloud * 0.7 - s.rain * 0.3, 0.15, 1) * (high ? clamp((sunPos.elevation * DEG + 5) / 12, 0, 1) : 0.9));
    // clouds: more of them, and greyer, as the sky fills
    const shown = Math.round(1 + s.cloud * 12);
    const tint = mix("#ffffff", s.storm ? "#4a525d" : "#8e98a4", s.gloom * 1.2);
    for (const k of clouds) {
      k.show = k.low || k.rank < shown;
      k.c.userData.body.color.set(k.low ? mix(tint, s.skyBottom, 0.35) : tint);
      k.c.userData.body.emissiveIntensity = 0.08 + 0.2 * s.day;
      k.c.userData.body.emissive.set(mix("#6a7390", "#ffffff", s.day));
    }
    rainLines.visible = s.rain > 0.04;
    rainLines.material.opacity = 0.25 + 0.4 * s.rain;
    rainGeo.setDrawRange(0, Math.floor(RAIN * 2 * clamp(s.rain, 0, 1)));
    for (const f of flocks) for (const { b } of f.birds) b.visible = s.day > 0.25 && s.rain < 0.55;
    // the control bar's readout
    const clock = bangkokClock(when);
    const condition = weather.condition ?? "clear";
    const icon = s.day < 0.25 && condition === "clear" ? "☾" : CONDITION_ICON[condition] ?? "☀";
    const temp = ctl.live && ctl.weather === "live" && weather.tempC != null ? ` · ${weather.tempC}°C` : "";
    skyChip.textContent = `${icon} ${clock.label}${temp} · ${CONDITION_WORD[condition] ?? condition}`;
    const real = ctl.live && ctl.weather === "live" ? (ctl.liveWeather ? "Bangkok's weather right now" : "no live weather (clear sky)") : "chosen by hand";
    panelInfo.textContent = `Bangkok ${clock.label} · sun ${Math.round(sunPos.elevation * DEG)}° high, ${Math.round(sunPos.azimuth * DEG)}° · ${real}`;
    hourText.textContent = `Hour ${clock.label}`;
  }
  const setHourFromClock = () => { ctl.hour = bangkokClock(new Date()).hour; hourInput.value = String(ctl.hour); };
  setHourFromClock();
  const setLive = (live) => {
    ctl.live = live;
    if (!live) { setHourFromClock(); }
    liveButton.classList.toggle("on", live);
    manualButton.classList.toggle("on", !live);
    hourInput.disabled = live;
    applySky();
  };
  liveButton.addEventListener("click", () => { weatherSelect.value = "live"; ctl.weather = "live"; setLive(true); });
  manualButton.addEventListener("click", () => setLive(false));
  hourInput.addEventListener("input", () => { ctl.hour = Number(hourInput.value); applySky(); });
  weatherSelect.addEventListener("change", () => { ctl.weather = weatherSelect.value; applySky(); });
  skyChip.addEventListener("click", () => { panel.hidden = !panel.hidden; });
  hourInput.disabled = true;

  // ---------- the frame ----------
  const tmp = new THREE.Vector3();
  let raf = 0;
  let last = 0;
  let running = false;
  let blurred = !document.hasFocus();

  function project(x, y, z) {
    tmp.set(x, y, z).project(camera);
    return { x: (tmp.x * 0.5 + 0.5) * w, y: (-tmp.y * 0.5 + 0.5) * h, inView: tmp.z < 1 && Math.abs(tmp.x) < 1.1 && Math.abs(tmp.y) < 1.1 };
  }
  function place(node, p, dy = 0) {
    node.style.visibility = p.inView ? "visible" : "hidden";
    if (p.inView) node.style.transform = `translate(${p.x.toFixed(1)}px, ${(p.y + dy).toFixed(1)}px) translate(-50%, -100%)`;
  }

  // Walk the route to the target, corner by corner; a new target means a new route.
  function walk(a, st, dt) {
    if (Math.hypot(st.target.x - a.goal.x, st.target.z - a.goal.z) > 0.01) {
      a.goal = { x: st.target.x, z: st.target.z };
      if (REDUCED) a.pos = { x: st.target.x, z: st.target.z };
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
  const turn = (from, to, k) => {
    const d = ((to - from + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    return from + d * Math.min(1, k);
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
      a.group.rotation.z = s * 0.07;
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
      bob = Math.abs(Math.sin(sec * 5 + k)) * 0.22;
      left.rotation.z = 2.6;
      right.rotation.z = -2.6;
      a.stars.rotation.y = sec * 2.5;
    } else if (st.mode === "waiting") {
      right.rotation.z = -2.6 + Math.sin(sec * 7) * 0.3;
      bob = Math.abs(Math.sin(sec * 4)) * 0.06;
    } else {
      bob = Math.sin(sec * 1.8 + k) * 0.02;
    }
    a.body.position.y = 0.55 + bob;
    a.head.position.y = 1.1 + bob * 1.2;
  }

  // Names and bubbles over the characters. Agents that gather at one building would pile their
  // bubbles on top of each other, so from the lowest on screen up, each is lifted above any tag
  // it overlaps (or stacked downwards when there is no room under the top bar). All measuring
  // comes first, then all writing: one layout per frame.
  function placeTags() {
    const tags = avatars.map((a) => {
      const p = project(a.pos.x, 2.7, a.pos.z);
      const { width: tw, height: th } = a.tag.getBoundingClientRect();
      return { a, tw, th, ...p };
    }).sort((p, q) => q.y - p.y);
    const placed = [];
    const clash = (t) => placed.find((p) => Math.abs(t.x - p.x) < (t.tw + p.tw) / 2 + 4 && t.y > p.y - p.th - 4 && t.y - t.th < p.y + 4);
    const TOP = 60;
    for (const t of tags.filter((x) => x.inView)) {
      const homeY = t.y;
      for (let pass = 0, hit; pass < tags.length && (hit = clash(t)); pass++) t.y = hit.y - hit.th - 4;
      if (t.y - t.th < TOP && t.y !== homeY) {
        t.y = homeY;
        for (let pass = 0, hit; pass < tags.length && (hit = clash(t)); pass++) t.y = hit.y + t.th + 4;
      }
      placed.push(t);
    }
    for (const t of tags) place(t.a.tag, t);
  }

  const keyAxis = (neg, pos) => (keys.has(pos) ? 1 : 0) - (keys.has(neg) ? 1 : 0);
  const zoneCaptions = [
    ["TOWN SQUARE", terrain.plaza.x, terrain.plaza.z - 3.5],
    ["HARBOUR", layout.stations.filter((s) => s.zone === "platform").reduce((m, s) => m + s.x, 0) / Math.max(1, layout.stations.filter((s) => s.zone === "platform").length), 33],
    ["THE MOUNTAINS", cx, minZ + 14],
  ].map(([text, x, z]) => {
    const node = el("div", "office-zone", text);
    labels.append(node);
    return { node, x, z };
  });

  function frame(t) {
    raf = requestAnimationFrame(frame);
    // Unfocused but still on screen: keep it alive at a few frames a second (BLUR_FPS 0 pauses it).
    if (blurred && (!BLUR_FPS || t - last < 1000 / BLUR_FPS)) return;
    // rAF's timestamp can be older than the performance.now() the loop started with: never negative.
    const dt = Math.min(Math.max((t - last) / 1000 || 0, 0), 0.1);
    last = t;
    const now = Date.now();
    if (now - lastStates > 250) recompute(now);
    if (now - skyAt > (ctl.live ? 20_000 : 60_000)) applySky(now);
    const sec = t / 1000;

    // camera: keys, following, and easing towards the goal
    const fwd = keyAxis("s", "w") + keyAxis("arrowdown", "arrowup");
    const side = keyAxis("a", "d") + keyAxis("arrowleft", "arrowright");
    if (fwd || side) {
      const speed = (34 / view.zoom) * dt * (fast ? 2.5 : 1);
      goal.target.x += (-Math.sin(view.az) * fwd + Math.cos(view.az) * side) * speed;
      goal.target.z += (-Math.cos(view.az) * fwd - Math.sin(view.az) * side) * speed;
      clampTarget(goal.target);
      follow = null;
      followChip.hidden = true;
    }
    goal.az += keyAxis("q", "e") * 1.6 * dt;
    goal.zoom = clamp(goal.zoom * Math.exp((keyAxis("-", "=") + keyAxis("_", "+")) * 1.4 * dt), MIN_ZOOM, MAX_ZOOM);
    if (follow) { goal.target.x = follow.pos.x; goal.target.z = follow.pos.z; }
    const k = REDUCED ? 1 : 1 - Math.exp(-dt * 9);
    const moved = Math.abs(goal.az - view.az) + Math.abs(goal.el - view.el) + Math.abs(goal.zoom / view.zoom - 1) + view.target.distanceToSquared(goal.target);
    if (moved > 1e-5) {
      view.az += (goal.az - view.az) * k;
      view.el += (goal.el - view.el) * k;
      view.zoom *= (goal.zoom / view.zoom) ** k;
      view.target.lerp(goal.target, k);
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

    // buildings: rings, windows, gears, sails and labels (the small ones only when you are close)
    const maxTier = view.zoom >= 3.4 ? 2 : view.zoom >= 1.2 ? 1 : 0;
    for (const o of objects.values()) {
      const want = o.active ? 0.9 : o.key === selectedKey ? 0.8 : o.hover ? 0.5 : 0;
      o.glow += (want - o.glow) * Math.min(1, dt * 8);
      o.ring.material.opacity = o.glow;
      o.ring.material.color.set(o.active ?? (o.key === selectedKey ? SELECT_COLOR : "#ffffff"));
      o.ring.visible = o.glow > 0.01;
      o.lit += ((o.active ? 1.9 : 0.3 + 1.3 * sky.lamps) - o.lit) * Math.min(1, dt * 5);
      o.glass.emissiveIntensity = o.lit;
      o.gear.visible = Boolean(o.active);
      if (o.active && !REDUCED) {
        o.gear.rotation.z = sec * 2.2;
        o.gear.position.y = o.gearY + Math.sin(sec * 3) * 0.08;
      }
      if (o.sails && !REDUCED) o.sails.rotation.z = sec * (o.active ? 2.2 : 0.5);
      const hot = o.hover || o.key === selectedKey || Boolean(o.active);
      const on = o.tier <= maxTier || hot;
      if (on !== o.labelOn) { o.labelOn = on; o.text.hidden = !on; }
      if (on) {
        o.text.classList.toggle("hot", hot);
        place(o.text, project(o.x, 0.05, o.z), 14);
      }
    }
    for (const z of zoneCaptions) {
      const p = project(z.x, 0.1, z.z);
      z.node.hidden = view.zoom > 2.6;
      if (!z.node.hidden) place(z.node, p);
    }

    // world in motion: water, waterfall, clouds, birds, rain, motes, lightning
    if (!REDUCED) {
      world.water.flow.offset.y -= dt * 0.22;
      world.fall.tex.offset.y -= dt * 0.9;
      for (const [i, m] of world.mist.entries()) m.material.opacity = 0.35 + 0.15 * Math.sin(sec * 1.3 + i * 1.7);
      const wind = 1 + sky.cloud * 1.5 + sky.rain;
      for (const c of clouds) {
        c.c.visible = c.show && (c.low || view.zoom < 3.5); // the high ones step aside when you are close
        c.c.position.x += c.speed * wind * dt;
        if (c.c.position.x > maxX + 22) c.c.position.x = minX - 22;
      }
      for (const f of flocks) {
        const ang = f.phase + sec * f.speed;
        for (const { b, lag, side } of f.birds) {
          const th = ang - lag * Math.sign(f.speed);
          const x = f.cx + Math.cos(th) * f.radius + Math.sin(th) * side;
          const z = f.cz + Math.sin(th) * f.radius * 0.8 - Math.cos(th) * side;
          b.position.set(x, f.height + Math.sin(sec * 1.7 + lag * 20) * 0.6, z);
          b.rotation.y = Math.atan2(-Math.sin(th) * f.speed, Math.cos(th) * f.speed * 0.8) ;
          const flap = Math.sin(sec * 9 + lag * 30) * 0.7;
          b.userData.wings[0].rotation.z = flap;
          b.userData.wings[1].rotation.z = -flap;
        }
      }
      const p = moteGeo.attributes.position;
      for (let i = 0; i < MOTES; i++) {
        let y = p.getY(i) + moteSpeed[i] * dt;
        if (y > 7) y = 0.5;
        p.setY(i, y);
        p.setX(i, p.getX(i) + Math.sin(sec * 0.3 + i) * dt * 0.15);
      }
      p.needsUpdate = true;
      if (rainLines.visible) {
        const drift = 3 + sky.cloud * 4; // the wind slants the rain
        for (let i = 0; i < RAIN; i++) {
          const [rx, rz, ry, speed] = rainSeed[i];
          const yy = (((ry * 36 - sec * speed) % 36) + 36) % 36;
          const x = view.target.x + (rx - 0.5) * 150 + (yy / 36) * drift;
          const z = view.target.z + (rz - 0.5) * 120;
          rainPos.set([x, yy, z, x - 0.12 * drift, yy - 1.4, z], i * 6);
        }
        rainGeo.attributes.position.needsUpdate = true;
      }
      if (sky.storm) {
        nextFlash -= dt;
        if (nextFlash <= 0) { flashLevel = 1; nextFlash = 4 + Math.random() * 8; }
      }
      flashLevel = Math.max(0, flashLevel - dt * 3.2);
      flash.style.opacity = String(flashLevel * 0.45);
      hemi.intensity = sky.hemiPower + flashLevel * 2.5;
    }
    renderer.render(scene, camera);
  }

  // ---------- demo: a few made-up signals, local to this page ----------
  let demoCount = 0;
  const demoTimers = [];
  function demo() {
    demoTimers.forEach(clearTimeout);
    demoTimers.length = 0;
    const projects = layout.stations.filter((s) => s.zone === "project").map((s) => s.node);
    const services = layout.stations.filter((s) => s.zone === "annex").map((s) => s.node);
    const platforms = layout.stations.filter((s) => s.zone === "platform").map((s) => s.node);
    const at = (list, i) => list[i % Math.max(list.length, 1)];
    const script = [
      [0, "claude-code", at(projects, 1), "working", "Refactoring the importer"],
      [1200, "hermes", at(platforms, 0), "working", "Checking the deploy"],
      [2400, "buzz", at(services, 7), "working", "Drafting a launch thread"],
      [3600, "gemini", at(projects, 1), "working", "Reviewing the pull request"],
      [4800, "chatgpt", at(services, 14), "working", "Summarising the docs"],
      [14000, "claude-code", at(projects, 1), "done", "All tests green"],
      [16000, "buzz", at(services, 7), "waiting", "Needs your OK to post"],
      [19000, "hermes", at(platforms, 0), "done", "Deploy healthy"],
      [21000, "gemini", at(projects, 1), "done", "Review finished"],
      [23000, "chatgpt", at(services, 14), "done", "Docs summarised"],
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
  applySky();
  recompute();
  return {
    // The office is on screen: size it (it was hidden) and run the loop.
    show() {
      container.hidden = false;
      resize();
      applySky();
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
    // Highlight the building that stands for a node, and fly the camera to it.
    select(id) {
      const place2 = id ? locator.resolve(id) : null;
      selectedKey = place2?.key ?? null;
      const o = selectedKey && objects.get(selectedKey);
      if (o) flyTo(o.x, o.z, Math.max(view.zoom, 3.2));
    },
    demo,
    layout,
  };
}
