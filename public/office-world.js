// The land of the village, drawn from village.js's geometry: the island with its layers of earth,
// the mountains of the north rim, the river with its bridges and its waterfall, the roads, the
// plaza and the scenery (forest, bushes, rocks, flowers, lamps). Everything static is baked into
// a handful of meshes (bake() in office-parts.js); the river and the waterfall are the parts
// that move, so they are returned apart.
import * as THREE from "/vendor/three.module.js";
import { nearestOnPolyline, nearestRoad, rng, terrainAllows, insideIsland, distToSegment } from "./village.js";
import { PALETTE, bake, canvasTexture, cone, cyl, dotTexture, makeBench, makeBush, makeFountain, makeLamp, makeRock, makeTree, mat, rbox, shadowed, ball } from "./office-parts.js";

// A ribbon lying on the ground along a polyline: `width` metres wide, `y` above the ground, v
// running along its length (one texture repeat per `perV` metres).
function ribbon(points, width, y, perV = 4, closed = false) {
  const pts = closed ? [...points, points[0]] : points;
  const pos = [];
  const uv = [];
  const idx = [];
  let run = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const nx = -(b.z - a.z) / len;
    const nz = (b.x - a.x) / len;
    const w = typeof width === "function" ? width(i / (pts.length - 1)) : width;
    if (i) run += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    pos.push(pts[i].x + nx * w / 2, y, pts[i].z + nz * w / 2, pts[i].x - nx * w / 2, y, pts[i].z - nz * w / 2);
    uv.push(0, run / perV, 1, run / perV);
    if (i) {
      const k = i * 2;
      idx.push(k - 2, k - 1, k, k - 1, k + 1, k);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // the winding above may face down; make every normal point up
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  const index = g.index.array;
  for (let i = 0; i < index.length; i += 3) {
    const [a, b, c] = [index[i], index[i + 1], index[i + 2]];
    const ax = pos[b * 3] - pos[a * 3];
    const az = pos[b * 3 + 2] - pos[a * 3 + 2];
    const bx = pos[c * 3] - pos[a * 3];
    const bz = pos[c * 3 + 2] - pos[a * 3 + 2];
    if (az * bx - ax * bz < 0) { index[i + 1] = c; index[i + 2] = b; }
  }
  return g;
}

// The island as an extrusion of its outline (x, z → shape x, -y), `k` times its size.
function outlineGeometry(outline, k, depth, bevel = 0.12) {
  const shape = new THREE.Shape(outline.map((p) => new THREE.Vector2(p.x * k, -p.z * k)));
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 1 });
  g.rotateX(-Math.PI / 2); // shape y → -z, extrusion → up
  return g;
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

// soft light streaks on blue, scrolled to make the water run
const flowTexture = (vertical = false) => canvasTexture(128, (g, s) => {
  g.fillStyle = vertical ? "#bfe3f5" : "#74c7e8";
  g.fillRect(0, 0, s, s);
  const r = rng(vertical ? 3 : 8);
  g.lineCap = "round";
  for (let i = 0; i < 26; i++) {
    const x = r() * s;
    const y = r() * s;
    const len = 10 + r() * 30;
    g.strokeStyle = `rgba(255,255,255,${0.25 + r() * 0.4})`;
    g.lineWidth = 2 + r() * 3;
    for (const oy of [0, -s, s]) { g.beginPath(); g.moveTo(x, y + oy); g.lineTo(x + (r() - 0.5) * 4, y + oy + len); g.stroke(); }
  }
}, { repeat: true });

// Value noise in two dimensions, for clumps of forest.
function noise2(seed) {
  const r = rng(seed);
  const grid = Array.from({ length: 64 * 64 }, () => r());
  const at = (i, j) => grid[(((j % 64) + 64) % 64) * 64 + (((i % 64) + 64) % 64)];
  return (x, z) => {
    const fx = Math.floor(x);
    const fz = Math.floor(z);
    const tx = x - fx;
    const tz = z - fz;
    const sx = tx * tx * (3 - 2 * tx);
    const sz = tz * tz * (3 - 2 * tz);
    const a = at(fx, fz) * (1 - sx) + at(fx + 1, fz) * sx;
    const b = at(fx, fz + 1) * (1 - sx) + at(fx + 1, fz + 1) * sx;
    return a * (1 - sz) + b * sz;
  };
}

export function buildWorld({ scene, layout, renderer }) {
  const { terrain } = layout;
  const root = new THREE.Group(); // everything static goes under here and is baked at the end
  const r = rng(2024);
  const out = { water: null, fall: null, mist: [], lamps: [], bridgePoints: [] };

  // ---- the island: grass on top, layers of earth below, roots hanging from the underside ----
  const grass = grassTexture();
  grass.repeat.set(1 / 7, 1 / 7);
  grass.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const grassM = mat("#ffffff", { rough: 0.95, unique: true });
  grassM.map = grass;
  const soilM = mat(PALETTE.soil, { rough: 1 });
  const top = shadowed(new THREE.Mesh(outlineGeometry(terrain.outline, 1, 0.7), [grassM, soilM]), { cast: false });
  top.position.y = -0.82;
  root.add(top);
  [[0.9, 1.0], [0.72, 1.0], [0.52, 0.9], [0.3, 0.8]].forEach(([k, thick], i) => {
    const layer = shadowed(new THREE.Mesh(outlineGeometry(terrain.outline, k, thick), [mat(PALETTE.soilDark, { rough: 1 }), mat(i % 2 ? "#a77b56" : PALETTE.soil, { rough: 1 })]), { receive: false });
    layer.position.y = -0.82 - 1.0 * (i + 1) - (i > 1 ? 0.1 : 0);
    root.add(layer);
  });
  for (let i = 0; i < 16; i++) { // stalactite rocks and roots under the island
    const t = r() * Math.PI * 2;
    const k = 0.25 + r() * 0.55;
    const rim = terrain.outline[Math.floor((t / (Math.PI * 2)) * terrain.outline.length) % terrain.outline.length];
    const spike = shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.8 + r() * 1.2, 3 + r() * 4, 6), mat(i % 3 ? "#9a7050" : "#8a8f96", { flat: true })), { receive: false });
    spike.rotation.x = Math.PI;
    spike.position.set(rim.x * k, -5.5 - r() * 2, rim.z * k);
    root.add(spike);
  }

  // ---- mountains: faceted peaks along the north, snow on the tallest; low green hills elsewhere ----
  for (const [i, m] of terrain.mountains.entries()) {
    if (m.h < 6) {
      const hill = shadowed(new THREE.Mesh(new THREE.SphereGeometry(1, 14, 8), mat("#8fcb77", { rough: 1 })), { cast: true });
      hill.scale.set(m.r, m.h, m.r * 0.9);
      hill.position.set(m.x, -m.h * 0.15, m.z);
      root.add(hill);
      continue;
    }
    const geo = new THREE.ConeGeometry(m.r, m.h, 8, 4);
    const p = geo.attributes.position;
    const jr = rng(i * 97 + 5);
    for (let v = 0; v < p.count; v++) { // roughen the cone so no two sides are alike
      const y = p.getY(v);
      if (y < -m.h / 2 + 0.01) continue;
      const f = 1 - (y + m.h / 2) / m.h;
      p.setXYZ(v, p.getX(v) + (jr() - 0.5) * m.r * 0.28 * f, y + (jr() - 0.5) * m.h * 0.06, p.getZ(v) + (jr() - 0.5) * m.r * 0.28 * f);
    }
    geo.computeVertexNormals();
    const rock = shadowed(new THREE.Mesh(geo, mat(i % 2 ? "#8d9db0" : "#9aa7b3", { flat: true, rough: 1 })));
    rock.position.set(m.x, m.h / 2 - 0.3, m.z);
    root.add(rock);
    if (m.h > 12) {
      const cap = shadowed(new THREE.Mesh(new THREE.ConeGeometry(m.r * 0.42, m.h * 0.34, 8, 2), mat("#ffffff", { flat: true, rough: 0.9 })));
      cap.position.set(m.x, m.h * 0.83 - 0.3, m.z);
      root.add(cap);
    }
    const base = shadowed(new THREE.Mesh(new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), mat("#7fbf72", { rough: 1 })));
    base.scale.set(m.r * 1.25, m.h * 0.16, m.r * 1.25); // a green skirt of foothills
    base.position.set(m.x, -0.1, m.z);
    root.add(base);
  }

  // ---- roads: a sand ribbon with a darker edge, and doorsteps ----
  const sand = mat(PALETTE.sand, { rough: 1 });
  const edge = mat(PALETTE.sandDark, { rough: 1 });
  terrain.roads.forEach((road) => {
    root.add(shadowed(new THREE.Mesh(ribbon(road.points, 2.45, 0.035, 4, road.closed), edge), { cast: false }));
    root.add(shadowed(new THREE.Mesh(ribbon(road.points, 1.9, 0.045, 4, road.closed), sand), { cast: false }));
  });
  const g = layout.graph;
  for (let i = g.roadNodes; i < g.nodes.length; i++) { // a doorstep is a graph point linked to the road
    const to = g.adj[i][0]?.[0];
    if (to == null) continue;
    root.add(shadowed(new THREE.Mesh(ribbon([g.nodes[i], g.nodes[to]], 1.0, 0.05, 2), sand), { cast: false }));
  }

  // ---- the plaza: paving, a fountain, benches, lamps ----
  const { plaza } = terrain;
  const paving = cyl(plaza.r - 0.5, plaza.r - 0.5, 0.1, mat("#efe6d3", { rough: 0.95 }), plaza.x, 0.05, plaza.z, 40);
  paving.castShadow = false;
  const ringStone = cyl(plaza.r - 0.1, plaza.r - 0.1, 0.07, mat(PALETTE.sandDark, { rough: 0.95 }), plaza.x, 0.035, plaza.z, 40);
  ringStone.castShadow = false;
  root.add(ringStone, paving);
  const fountain = makeFountain();
  fountain.position.set(plaza.x, 0.1, plaza.z);
  root.add(fountain);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    const bench = makeBench();
    bench.position.set(plaza.x + Math.cos(a) * (plaza.r - 1.9), 0.08, plaza.z + Math.sin(a) * (plaza.r - 1.9));
    bench.rotation.y = -a - Math.PI / 2;
    root.add(bench);
    if (i % 2 === 0) {
      const lamp = makeLamp();
      lamp.position.set(plaza.x + Math.cos(a + 0.5) * (plaza.r - 0.9), 0.08, plaza.z + Math.sin(a + 0.5) * (plaza.r - 0.9));
      root.add(lamp);
      out.lamps.push({ x: lamp.position.x, z: lamp.position.z });
    }
  }

  // ---- river: banks, water that runs, bridges where roads cross, a waterfall over the south rim ----
  const river = terrain.river;
  root.add(shadowed(new THREE.Mesh(ribbon(river.points, (t) => river.width + 2.2 + t * 1.2, 0.03, 6), mat("#e8d9b4", { rough: 1 })), { cast: false }));
  const flow = flowTexture();
  const waterM = new THREE.MeshStandardMaterial({ color: "#ffffff", map: flow, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.93, emissive: "#2f86b0", emissiveIntensity: 0.15 });
  const water = new THREE.Mesh(ribbon(river.points, (t) => river.width + t * 1.2, 0.07, 5), waterM);
  water.receiveShadow = true;
  water.userData.keep = true;
  scene.add(water);
  out.water = { mesh: water, flow };

  for (const b of terrain.bridges) {
    const bridge = new THREE.Group();
    const len = river.width + 4.6;
    const wood = mat(PALETTE.wood, { rough: 0.8 });
    const dark = mat(PALETTE.woodDark, { rough: 0.8 });
    bridge.add(rbox(1.9, 0.22, len, 0.05, wood, 0, 0.32, 0));
    for (const s of [-1, 1]) {
      bridge.add(rbox(0.1, 0.1, len, 0.03, dark, s * 0.95, 0.85, 0));
      for (let k = -2; k <= 2; k++) bridge.add(rbox(0.1, 0.6, 0.1, 0.03, dark, s * 0.95, 0.55, (k * len) / 5));
    }
    for (const s of [-1, 1]) bridge.add(rbox(1.9, 0.5, 0.7, 0.05, mat(PALETTE.stone, { rough: 0.95 }), 0, 0.15, s * (len / 2 - 0.2)));
    bridge.position.set(b.x, 0, b.z);
    bridge.rotation.y = b.angle;
    root.add(bridge);
    out.bridgePoints.push({ x: b.x, z: b.z });
  }

  // the waterfall: a curtain of water from the rim down into the clouds, and mist at its foot
  const m = river.mouth;
  const fallTex = flowTexture(true);
  const fall = new THREE.Mesh(new THREE.PlaneGeometry(river.width * 1.35, 16), new THREE.MeshBasicMaterial({ map: fallTex, transparent: true, opacity: 0.88, depthWrite: false, side: THREE.DoubleSide }));
  fall.position.set(m.x + Math.sin(m.angle) * 0.4, -7.8, m.z + Math.cos(m.angle) * 0.4);
  fall.rotation.y = m.angle;
  fall.userData.keep = true;
  scene.add(fall);
  out.fall = { mesh: fall, tex: fallTex };
  for (let i = 0; i < 4; i++) {
    const mist = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture(), color: "#ffffff", transparent: true, opacity: 0.5, depthWrite: false }));
    mist.scale.setScalar(6 + i * 1.6);
    mist.position.set(m.x + Math.sin(m.angle) * (1 + i * 0.5), -14.5 + i * 0.4, m.z + Math.cos(m.angle) * (1 + i * 0.5));
    scene.add(mist);
    out.mist.push(mist);
  }

  // ---- scenery: where nothing else is ----
  const buildings = [...layout.desks, ...layout.stations];
  const free = (x, z, pad) =>
    insideIsland(x, z, 2.2) &&
    nearestOnPolyline({ x, z }, river.points).d > river.width / 2 + 1.6 + pad &&
    !terrain.mountains.some((q) => Math.hypot(x - q.x, z - q.z) < q.r * 0.95 + pad) &&
    Math.hypot(x - plaza.x, z - plaza.z) > plaza.r + 0.8 &&
    !nearestRoad(terrain, { x, z }, 1.9 + pad) &&
    buildings.every((b) => Math.hypot(x - b.x, z - b.z) > b.radius + 0.9 + pad && distToSegment({ x, z }, b.stand, b.stand).d > 1.4 + pad);
  const clump = noise2(31);
  let trees = 0;
  for (let tries = 0; tries < 6000 && trees < 230; tries++) {
    const x = (r() - 0.5) * 2 * terrain.island.a;
    const z = (r() - 0.5) * 2 * terrain.island.b;
    const density = clump(x * 0.07 + 5, z * 0.07 + 9);
    const rim = !insideIsland(x, z, 9);
    if (!free(x, z, 0.6) || r() > (rim ? 0.9 : density > 0.58 ? 0.75 : 0.05)) continue;
    const nearRiver = nearestOnPolyline({ x, z }, river.points).d < river.width / 2 + 7;
    const tree = makeTree(r, nearRiver && r() < 0.45 ? 2 : Math.floor(r() * 10));
    tree.position.set(x, 0, z);
    root.add(tree);
    trees++;
  }
  for (let tries = 0, n = 0; tries < 3000 && n < 170; tries++) {
    const x = (r() - 0.5) * 2 * terrain.island.a;
    const z = (r() - 0.5) * 2 * terrain.island.b;
    if (!free(x, z, 0.3)) continue;
    const near = nearestRoad(terrain, { x, z }, 9);
    if (r() > (near ? 0.5 : 0.1)) continue;
    const bush = makeBush(r);
    bush.position.set(x, 0, z);
    root.add(bush);
    n++;
  }
  for (let tries = 0, n = 0; tries < 2000 && n < 50; tries++) {
    const x = (r() - 0.5) * 2 * terrain.island.a;
    const z = (r() - 0.5) * 2 * terrain.island.b;
    const bank = nearestOnPolyline({ x, z }, river.points).d < river.width / 2 + 3.5;
    if (!free(x, z, 0.2) && !(bank && insideIsland(x, z, 2))) continue;
    if (nearestOnPolyline({ x, z }, river.points).d < river.width / 2 + 0.3) continue;
    if (!bank && r() > 0.2) continue;
    const rock = makeRock(r);
    rock.position.set(x, 0, z);
    root.add(rock);
    n++;
  }
  // street lamps along the roads, every so often, on the near side
  let lampTick = 0;
  for (const road of terrain.roads.filter((q) => q.id !== "plaza")) {
    for (let i = 3; i < road.points.length; i += 7) {
      const a = road.points[i - 1];
      const b = road.points[i];
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const x = a.x - ((b.z - a.z) / len) * 1.7;
      const z = a.z + ((b.x - a.x) / len) * 1.7;
      if (!free(x, z, -0.7) || (lampTick++ % 2)) continue;
      const lamp = makeLamp();
      lamp.position.set(x, 0, z);
      root.add(lamp);
      if (out.lamps.length < 24) out.lamps.push({ x, z });
    }
  }
  const FLOWERS = 420;
  const flowers = new THREE.InstancedMesh(new THREE.SphereGeometry(0.09, 8, 6), mat("#ffffff", { rough: 0.7 }), FLOWERS);
  const dummy = new THREE.Object3D();
  const petals = ["#ff8fa8", "#ffd45e", "#ffffff", "#c98bd1", "#8ec9f0"];
  let n = 0;
  for (let tries = 0; n < FLOWERS && tries < 6000; tries++) {
    const x = (r() - 0.5) * 2 * terrain.island.a;
    const z = (r() - 0.5) * 2 * terrain.island.b;
    if (!free(x, z, 0.2) || r() > 0.5) continue;
    dummy.position.set(x, 0.1, z);
    dummy.scale.setScalar(0.7 + r() * 0.8);
    dummy.updateMatrix();
    flowers.setMatrixAt(n, dummy.matrix);
    flowers.setColorAt(n, new THREE.Color(petals[Math.floor(r() * petals.length)]));
    n++;
  }
  flowers.count = n;
  scene.add(flowers);

  scene.add(root);
  out.root = root;
  out.flowers = flowers;
  out.bake = () => { for (const mesh of bake(root)) root.add(mesh); };
  out.free = free;
  return out;
}
