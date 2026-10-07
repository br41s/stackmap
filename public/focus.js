// Focus mode: the camera flies to a node, it grows and pulses, its neighbours fly into an
// orbit around it (uses → right, used by ← left), light flows along the relations, and the
// rest of the map recedes. Travelling re-centres on a neighbour; exit flies everything home.
//
// Positions are borrowed, never lost: the overview's positions and viewport are snapshotted on
// entry and restored on exit. Opacity, size and glow change through style classes, which
// Cytoscape transitions on its own (see `transition-*` in app.js); only motion is animated here.
import { orbitPositions } from "./orbit.js";

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const FLY_MS = REDUCED ? 0 : 950;
const CAMERA_MS = REDUCED ? 0 : 1150;
const EASE_NODES = "ease-out-quint";
const EASE_CAMERA = "ease-in-out-cubic";
const FOCUS_CLASSES = "dim ghost hero orbit beam beam-in beam-out";

export function createFocus(cy, { insets = () => ({ left: 40, right: 40, top: 80, bottom: 60 }), maxZoom = 1.7 } = {}) {
  let saved = null;      // { positions: Map<id, {x, y}>, zoom, pan } — the overview to return to
  let hero = null;       // id
  const history = [];
  let raf = 0;

  const leaves = () => cy.nodes().filter((n) => !n.isParent());

  function snapshot() {
    return {
      positions: new Map(leaves().map((n) => [n.id(), { ...n.position() }])),
      zoom: cy.zoom(),
      pan: { ...cy.pan() },
    };
  }

  // One flight per node, stopped on its own: `node.stop()` would also kill the opacity/size
  // transition its new class just started, freezing it half-faded.
  const flights = new Map();
  function fly(n, to) {
    flights.get(n.id())?.stop();
    if (FLY_MS === 0) return n.position(to);
    const flight = n.animation({ position: to }, { duration: FLY_MS, easing: EASE_NODES, queue: false });
    flights.set(n.id(), flight);
    flight.play().promise().then(() => {
      if (flights.get(n.id()) === flight) flights.delete(n.id());
    });
  }

  // Zoom/pan so the given model-space box sits in the free part of the screen (the HUD
  // covers the left). Computed from the TARGET box: nodes are still in flight.
  function camera(box) {
    const ins = insets();
    const w = Math.max(cy.width() - ins.left - ins.right, 100);
    const h = Math.max(cy.height() - ins.top - ins.bottom, 100);
    const zoom = Math.min(maxZoom, w / Math.max(box.w, 1), h / Math.max(box.h, 1));
    const cx = box.x1 + box.w / 2;
    const cyy = box.y1 + box.h / 2;
    const pan = { x: ins.left + w / 2 - cx * zoom, y: ins.top + h / 2 - cyy * zoom };
    cy.stop(true);
    if (CAMERA_MS === 0) cy.viewport({ zoom, pan });
    else cy.animate({ zoom, pan }, { duration: CAMERA_MS, easing: EASE_CAMERA });
  }

  function boxOf(points, marginX = 110, marginY = 60) {
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const x1 = Math.min(...xs) - marginX;
    const y1 = Math.min(...ys) - marginY;
    return { x1, y1, w: Math.max(...xs) + marginX - x1, h: Math.max(...ys) + marginY + 30 - y1 };
  }

  // Light runs along each relation in its direction, and the hero breathes.
  function startFlow() {
    if (REDUCED || raf) return;
    const tick = (t) => {
      const offset = -(t / 28) % 48;
      const pulse = 9 + 5 * Math.sin(t / 420);
      cy.batch(() => {
        cy.edges(".beam").style("line-dash-offset", offset);
        cy.nodes(".hero").style("underlay-padding", pulse);
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  function stopFlow() {
    cancelAnimationFrame(raf);
    raf = 0;
    cy.edges().removeStyle("line-dash-offset");
    cy.nodes().removeStyle("underlay-padding");
  }

  function enter(id, { remember = true } = {}) {
    const node = cy.getElementById(id);
    if (node.empty() || node.isParent()) return false;
    if (!saved) saved = snapshot();
    if (hero && hero !== id && remember) history.push(hero);
    hero = id;

    const beams = node.connectedEdges();
    const outIds = beams.filter((e) => e.source().id() === id).map((e) => e.target().id());
    const inIds = beams.filter((e) => e.target().id() === id).map((e) => e.source().id());
    const center = { ...node.position() };
    const targets = orbitPositions(center, outIds, inIds);
    const crew = new Set([id, ...targets.keys()]);

    cy.batch(() => {
      cy.elements().removeClass(FOCUS_CLASSES).addClass("dim");
      // A compound's opacity multiplies into everything inside it: dimming a group box would
      // dim the neighbours it contains. Boxes only turn invisible.
      cy.nodes(":parent").removeClass("dim").addClass("ghost");
      node.removeClass("dim").addClass("hero");
      for (const nid of targets.keys()) cy.getElementById(nid).removeClass("dim ghost").addClass("orbit");
      beams.removeClass("dim").addClass("beam");
      beams.filter((e) => e.source().id() === id).addClass("beam-out");
      beams.filter((e) => e.target().id() === id).addClass("beam-in");
    });

    // Whoever is not in this orbit goes home; the crew flies into position. An open group
    // (a compound) cannot be moved without dragging its contents, so it stays where it is.
    for (const n of leaves()) {
      if (crew.has(n.id())) continue;
      const home = saved.positions.get(n.id());
      const p = n.position();
      if (home && (Math.abs(home.x - p.x) > 0.5 || Math.abs(home.y - p.y) > 0.5)) fly(n, home);
    }
    const points = [center];
    for (const [nid, pos] of targets) {
      const n = cy.getElementById(nid);
      if (n.isParent()) {
        const bb = n.boundingBox();
        points.push({ x: bb.x1, y: bb.y1 }, { x: bb.x2, y: bb.y2 });
      } else {
        fly(n, pos);
        points.push(pos);
      }
    }
    camera(boxOf(points));
    startFlow();
    return true;
  }

  function back() {
    const prev = history.pop();
    if (prev && cy.getElementById(prev).nonempty()) return enter(prev, { remember: false }) && prev;
    exit();
    return null;
  }

  // animate=false: snap back instantly (before a re-layout replaces every element anyway).
  function exit({ animate = true } = {}) {
    if (!saved) return;
    stopFlow();
    for (const n of leaves()) {
      const home = saved.positions.get(n.id());
      if (!home) continue;
      if (animate) fly(n, home);
      else {
        flights.get(n.id())?.stop();
        n.position(home);
      }
    }
    cy.elements().removeClass(FOCUS_CLASSES);
    if (animate && CAMERA_MS) cy.stop(true).animate({ zoom: saved.zoom, pan: saved.pan }, { duration: CAMERA_MS, easing: EASE_CAMERA });
    else cy.viewport({ zoom: saved.zoom, pan: saved.pan });
    saved = null;
    hero = null;
    history.length = 0;
  }

  return {
    enter,
    exit,
    back,
    camera,
    active: () => saved !== null,
    hero: () => hero,
    canGoBack: () => history.length > 0,
  };
}
