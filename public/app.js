// The map: loads /api/stack, draws the expanded part of the tree with Cytoscape + fcose, and
// turns every click into a camera move. A node → focus mode (focus.js): it grows, its
// relations fly into orbit, the HUD types out a briefing. An open group → the camera frames
// it. Search, chat links and HUD chips all travel the same way.
import { buildIndex, ancestry, descendantCount, visibleNodeIds, liftEdges, representative } from "./graph-model.js";
import { initChat, openChat } from "./chat.js";
import { createFocus } from "./focus.js";
import { narrate } from "./narrate.js";

const LAYER_COLORS = {
  "layer-hosting": "#5b9dff",
  "layer-agents": "#b47cff",
  "layer-dev": "#ffb547",
  "layer-products": "#38d989",
  "layer-external": "#9aa7c2",
};
const ROOT_COLOR = "#ff6b6b"; // nodes outside the layers (Brais)
const SHAPES = {
  layer: "round-rectangle", platform: "round-rectangle", project: "round-rectangle", service: "round-rectangle",
  server: "cut-rectangle", database: "barrel", agent: "round-hexagon", bot: "round-hexagon",
  "cron-job": "round-diamond", tool: "round-tag", "mcp-server": "round-tag", skill: "round-pentagon",
  hook: "round-triangle", config: "rhomboid", doc: "rhomboid", repo: "bottom-round-rectangle",
  domain: "tag", channel: "ellipse", external: "ellipse", person: "star",
};
const EDGE_GROUPS = {
  runtime: { color: "#7f93c4", label: "runs on / serves / stores in / depends on", kinds: ["deployed-on", "serves", "stores-in", "depends-on"] },
  data: { color: "#2fd4e8", label: "calls / reads / writes / uses model / routes", kinds: ["calls", "reads", "writes", "uses-model", "routes-to"] },
  notify: { color: "#ff79c6", label: "notifies", kinds: ["notifies"] },
  control: { color: "#ffc04d", label: "deploys / manages / monitors / configures / backs up", kinds: ["deploys", "manages", "controls", "monitors", "configures", "backs-up-to"] },
};
const edgeGroup = (kind) => Object.keys(EDGE_GROUPS).find((g) => EDGE_GROUPS[g].kinds.includes(kind)) ?? "runtime";
const edgeColor = (kind) => EDGE_GROUPS[edgeGroup(kind)].color;
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

const $ = (sel) => document.querySelector(sel);
const state = { stack: null, index: null, expanded: new Set(), selected: null, laidOut: false, lifted: new Map() };
let cy;
let focus;

// Tiny DOM builder so data never goes through innerHTML.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids(children));
  return el;
}

// Nested arrays flattened, null/false dropped: append()/replaceChildren() would print them.
const kids = (children) => children.flat(Infinity).filter((c) => c != null && c !== false);
const fill = (el, ...children) => el.replaceChildren(...kids(children));

const node = (id) => state.index.byId.get(id);
const hasChildren = (id) => (state.index.children.get(id)?.length ?? 0) > 0;
const colorOf = (id) => LAYER_COLORS[ancestry(state.index, id)[0]] ?? ROOT_COLOR;
const layerOf = (id) => node(ancestry(state.index, id)[0])?.label ?? "";
const descendants = (id) => (state.index.children.get(id) ?? []).flatMap((c) => [c, ...descendants(c)]);
const defaultExpanded = () => new Set(state.stack.nodes.filter((n) => n.kind === "layer" && hasChildren(n.id)).map((n) => n.id));

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function cyStyle() {
  const text = cssVar("--text");
  const bg = cssVar("--bg");
  const accent = cssVar("--accent");
  // Class changes (dim, hero, orbit…) fade and resize on their own through these.
  const nodeFx = { "transition-property": "opacity, width, height, font-size, underlay-opacity, text-opacity, background-opacity, border-opacity", "transition-duration": REDUCED ? 0 : 650, "transition-timing-function": "ease-in-out-cubic" };
  const edgeFx = { "transition-property": "opacity, width, line-color", "transition-duration": REDUCED ? 0 : 650 };
  return [
    { selector: "node", style: {
      ...nodeFx,
      "background-color": "data(color)", "background-opacity": 0.95, shape: (el) => SHAPES[el.data("kind")] ?? "round-rectangle",
      width: "data(size)", height: "data(size)",
      "underlay-color": "data(color)", "underlay-opacity": 0.18, "underlay-padding": 5, "underlay-shape": "ellipse",
      label: "data(label)", color: text, "font-size": 12, "font-weight": 500, "text-valign": "bottom", "text-margin-y": 6,
      "text-wrap": "wrap", "text-max-width": 130, "text-outline-color": bg, "text-outline-width": 3, "min-zoomed-font-size": 6,
    } },
    { selector: "node.collapsed", style: {
      "outline-width": 3, "outline-offset": 3, "outline-color": "data(color)", "outline-opacity": 0.45,
      "underlay-opacity": 0.28, "underlay-padding": 9, "font-weight": 600, "font-size": 15,
    } },
    { selector: "node.group", style: {
      shape: "round-rectangle", "background-opacity": 0.05, "border-width": 1.2, "border-color": "data(color)", "border-opacity": 0.5,
      "underlay-opacity": 0, "text-valign": "top", "text-margin-y": -8, "font-size": 15, "font-weight": 600, padding: 18,
      color: "data(color)",
    } },
    { selector: "node.layer.group", style: { "border-style": "dashed", "font-size": 22, "text-transform": "uppercase", padding: 30, "background-opacity": 0.025 } },
    { selector: "node.retired", style: { opacity: 0.42 } },
    { selector: "node.planned, node.dry-run", style: { "border-width": 2, "border-style": "dashed", "border-color": text, "border-opacity": 0.6 } },
    { selector: "node.inferred", style: { "font-style": "italic" } },
    { selector: "node.sel.group", style: { "border-width": 3, "border-color": accent, "border-opacity": 1, "background-opacity": 0.09 } },
    { selector: "edge", style: {
      ...edgeFx,
      width: "mapData(weight, 1, 12, 1.2, 4.5)", "line-color": "data(color)", "target-arrow-color": "data(color)",
      "target-arrow-shape": "triangle", "arrow-scale": 0.8, "curve-style": "bezier", "control-point-step-size": 16, opacity: 0.42,
    } },
    { selector: 'edge[kind = "deployed-on"]', style: { "line-style": "dashed", "line-dash-pattern": [6, 4] } },
    { selector: "edge.hl", style: { opacity: 0.95, "z-index": 10 } },
    { selector: "edge.hover", style: {
      opacity: 1, label: "data(label)", "font-size": 11, color: text, "text-rotation": "autorotate",
      "text-outline-color": bg, "text-outline-width": 3, "z-index": 20, width: 3,
    } },
    { selector: "node.faded", style: { opacity: 0.16 } },
    { selector: "edge.faded", style: { opacity: 0.05 } },

    // ---- focus mode (focus.js toggles these classes) ----
    { selector: ".dim", style: { opacity: 0.07, events: "no" } },
    { selector: "node.ghost", style: { "background-opacity": 0, "border-opacity": 0, "text-opacity": 0, events: "no" } },
    { selector: "node.hero", style: {
      width: 92, height: 92, "font-size": 22, "font-weight": 700, "text-margin-y": 12, "z-index": 30,
      "underlay-opacity": 0.42, "underlay-color": "data(color)", "outline-width": 0, "text-max-width": 220,
    } },
    { selector: "node.orbit", style: {
      width: (el) => Math.max(34, el.data("size")), height: (el) => Math.max(34, el.data("size")),
      "font-size": 14, "font-weight": 600, "underlay-opacity": 0.3, "underlay-padding": 7, "z-index": 25,
      "text-background-color": bg, "text-background-opacity": 0.72, "text-background-padding": 3, "text-background-shape": "round-rectangle",
    } },
    { selector: "edge.beam", style: {
      opacity: 0.95, width: "mapData(weight, 1, 12, 2.4, 6)", "line-style": "dashed", "line-dash-pattern": [16, 8], "z-index": 20,
      "font-size": 11, "font-weight": 600, color: "data(color)", "text-outline-color": bg, "text-outline-width": 3, "text-rotation": "autorotate",
    } },
    // The relation's name sits at the neighbour's end, so it never piles up on the hero.
    { selector: "edge.beam-out", style: { "target-label": "data(kindLabel)", "target-text-offset": 64 } },
    { selector: "edge.beam-in", style: { "source-label": "data(kindLabel)", "source-text-offset": 64 } },
    { selector: ".boot", style: { opacity: 0 } },
  ];
}

// ---------- rendering ----------

function elementsFor() {
  const { index, expanded } = state;
  const ids = visibleNodeIds(index, expanded);
  const old = new Map(cy.nodes().map((n) => [n.id(), { ...n.position() }]));
  const nodes = ids.map((id) => {
    const n = node(id);
    const kids = hasChildren(id);
    const open = kids && expanded.has(id);
    const inside = kids && !open ? descendantCount(index, id) : 0;
    let position = old.get(id);
    if (!position) {
      // New on screen: start where its closest ancestor was, so expanding "grows" out of it.
      const anchor = ancestry(index, id).reverse().find((a) => old.has(a));
      if (anchor) position = { x: old.get(anchor).x + (Math.random() - 0.5) * 60, y: old.get(anchor).y + (Math.random() - 0.5) * 60 };
    }
    const classes = [n.kind, n.status, n.confidence === "inferred" && "inferred", kids && (open ? "group" : "collapsed")];
    return {
      group: "nodes",
      data: {
        id, kind: n.kind, parent: n.parent ?? undefined, color: colorOf(id),
        label: inside ? `${n.label}  +${inside}` : n.label,
        size: inside ? Math.round(32 + Math.min(42, Math.sqrt(inside) * 6)) : n.kind === "layer" ? 60 : 24,
      },
      classes: classes.filter(Boolean).join(" "),
      position,
    };
  });
  state.lifted.clear();
  const edges = liftEdges(index, expanded).map((e, i) => {
    const id = `e${i}`;
    state.lifted.set(id, e);
    const weight = e.edges?.length ?? 1;
    const kinds = [...new Set(e.edges.map((x) => x.kind))];
    return {
      group: "edges",
      data: {
        id, source: e.source, target: e.target, kind: e.kind, color: edgeColor(e.kind), weight,
        label: weight > 1 ? `${e.label} (${weight})` : e.label,
        kindLabel: kinds.length > 2 ? `${kinds.slice(0, 2).join(" · ")} +${kinds.length - 2}` : kinds.join(" · "),
      },
    };
  });
  return [...nodes, ...edges];
}

function render({ fitTo, intro = false } = {}) {
  focus?.exit({ animate: false });
  cy.batch(() => {
    cy.elements().remove();
    cy.add(elementsFor());
  });
  highlight();
  return new Promise((resolve) => {
    const first = !state.laidOut;
    const layout = cy.layout({
      name: "fcose", quality: "default", randomize: first, animate: !first && !REDUCED, animationDuration: 600, fit: first, padding: 60,
      nodeDimensionsIncludeLabels: true, nodeRepulsion: 9000, idealEdgeLength: 110, edgeElasticity: 0.25, nestingFactor: 0.5,
      gravity: 0.35, gravityCompound: 1.4, gravityRangeCompound: 1.6, tile: true, tilingPaddingVertical: 24, tilingPaddingHorizontal: 24, numIter: 2500,
    });
    layout.one("layoutstop", () => {
      state.laidOut = true;
      if (intro) playIntro();
      else if (fitTo) frame(fitTo);
      resolve();
    });
    layout.run();
  });
}

// The free part of the screen. With a selection the HUD covers the left (a bottom sheet on a
// phone); its size is fixed in style.css, so the camera can aim before the HUD is drawn.
const HUD_WIDTH = 400;
function insets() {
  if (!state.selected) return { left: 40, right: 40, top: 84, bottom: 56 };
  if (innerWidth < 760) return { left: 16, right: 16, top: 72, bottom: Math.round(innerHeight * 0.46) + 16 };
  return { left: Math.min(HUD_WIDTH, innerWidth - 24) + 40, right: 40, top: 84, bottom: 56 };
}

// Bring a node and everything inside it into view.
function frame(id) {
  const el = cy.getElementById(id);
  if (el.empty()) return;
  const bb = el.union(el.descendants()).boundingBox({ includeLabels: true });
  focus.camera({ x1: bb.x1 - 40, y1: bb.y1 - 40, w: bb.w + 80, h: bb.h + 80 });
}

// Selection highlight for an open group (focus mode has its own classes).
function highlight() {
  cy.elements().removeClass("faded hl sel");
  const el = state.selected && cy.getElementById(state.selected);
  if (!el || el.empty() || !el.isParent()) return;
  const group = el.union(el.descendants());
  const edges = group.connectedEdges();
  const ends = edges.connectedNodes().union(group);
  el.addClass("sel");
  edges.addClass("hl");
  cy.elements().not(ends.union(ends.ancestors()).union(edges)).addClass("faded");
}

// The stack assembles itself: every node flies in from the centre, groups and relations fade
// in behind them, and the camera settles on the whole map.
function playIntro() {
  const title = $("#intro");
  if (REDUCED) {
    title.hidden = true;
    return;
  }
  const leaves = cy.nodes().filter((n) => !n.isParent());
  const final = new Map(leaves.map((n) => [n.id(), { ...n.position() }]));
  const bb = cy.elements().boundingBox();
  const center = { x: bb.x1 + bb.w / 2, y: bb.y1 + bb.h / 2 };
  cy.batch(() => {
    leaves.positions(() => ({ ...center }));
    cy.elements().addClass("boot");
  });
  const order = leaves.sort((a, b) => colorOf(a.id()).localeCompare(colorOf(b.id())) || Math.hypot(final.get(a.id()).x - center.x, final.get(a.id()).y - center.y) - Math.hypot(final.get(b.id()).x - center.x, final.get(b.id()).y - center.y));
  const step = Math.min(6, 1400 / Math.max(order.length, 1));
  order.forEach((n, i) => setTimeout(() => {
    n.removeClass("boot");
    n.animate({ position: final.get(n.id()) }, { duration: 1300, easing: "ease-out-quint" });
  }, 350 + i * step));
  const done = 350 + order.length * step + 900;
  setTimeout(() => cy.nodes(":parent").removeClass("boot"), 600);
  setTimeout(() => cy.edges().removeClass("boot"), done);
  focus.camera({ x1: bb.x1, y1: bb.y1, w: bb.w, h: bb.h });
  setTimeout(() => title.classList.add("gone"), 1700);
  setTimeout(() => (title.hidden = true), 2600);
}

// ---------- actions ----------

function toggle(id) {
  if (!hasChildren(id)) return;
  if (state.expanded.has(id)) {
    state.expanded.delete(id);
    if (state.selected && ancestry(state.index, state.selected).includes(id)) state.selected = id;
  } else {
    state.expanded.add(id);
  }
  render({ fitTo: id });
  showDetails();
}

// Every click lands here. A node flies into focus; an open group is framed.
function select(id) {
  const el = cy.getElementById(id);
  if (el.empty()) return reveal(id);
  state.selected = id;
  if (el.isParent()) {
    focus.exit();
    highlight();
    showDetails();
    frame(id);
  } else {
    highlight();
    focus.enter(id);
    showDetails();
  }
}

function clearSelection() {
  state.selected = null;
  focus.exit();
  highlight();
  showDetails();
}

function goBack() {
  const prev = focus.back();
  state.selected = prev ?? null;
  highlight();
  showDetails();
}

// Make a node visible (expand its ancestors) and fly to it.
async function reveal(id) {
  if (!node(id)) return;
  const missing = ancestry(state.index, id).slice(0, -1).filter((a) => !state.expanded.has(a));
  if (missing.length) {
    missing.forEach((a) => state.expanded.add(a));
    await render();
  }
  select(id);
}

// ---------- HUD ----------

// Every relation of a node (and what is inside it) to the rest of the map, the other end
// named by what is on screen — the same nodes the orbit shows.
function relationsOf(id) {
  const inside = new Set([id, ...descendants(id)]);
  const out = [];
  for (const e of state.stack.edges) {
    const s = inside.has(e.source);
    if (s === inside.has(e.target)) continue;
    const raw = s ? e.target : e.source;
    out.push({ dir: s ? "out" : "in", kind: e.kind, other: representative(state.index, raw, state.expanded), raw, edge: e });
  }
  return out;
}

let typing = 0;
// Types each block in turn; a click on the HUD finishes it at once.
function typeOut(blocks) {
  const run = ++typing;
  if (REDUCED) {
    blocks.forEach(({ el, text }) => (el.textContent = text));
    return;
  }
  const cursor = h("span", { class: "cursor" });
  let i = 0;
  let pos = 0;
  const step = () => {
    if (run !== typing) return;
    const block = blocks[i];
    if (!block) return cursor.remove();
    pos = Math.min(block.text.length, pos + 3);
    block.el.textContent = block.text.slice(0, pos);
    block.el.append(cursor);
    if (pos >= block.text.length) {
      i += 1;
      pos = 0;
    }
    requestAnimationFrame(step);
  };
  blocks.forEach(({ el }) => (el.textContent = ""));
  requestAnimationFrame(step);
  return () => {
    typing += 1;
    blocks.forEach(({ el, text }) => (el.textContent = text));
  };
}

function relationChips(rels, dir) {
  const byKind = new Map();
  for (const r of rels.filter((x) => x.dir === dir)) {
    if (!byKind.has(r.kind)) byKind.set(r.kind, new Set());
    byKind.get(r.kind).add(r.other);
  }
  if (!byKind.size) return null;
  const total = new Set(rels.filter((x) => x.dir === dir).map((x) => x.other)).size;
  return [
    h("h3", {}, dir === "out" ? `→ Uses (${total})` : `← Used by (${total})`),
    [...byKind].sort((a, b) => b[1].size - a[1].size).map(([kind, others]) =>
      h("div", { class: "rel-row" },
        h("span", { class: "rel-kind", style: `color:${edgeColor(kind)}` }, kind),
        h("div", { class: "chips" }, [...others].map((o) =>
          h("button", { type: "button", class: "chip", style: `--chip:${colorOf(o)}`, onclick: () => select(o) }, node(o)?.label ?? o))))),
  ];
}

function sourceItem(src) {
  const { workspace, home } = state.stack.meta;
  let abs = null;
  if (src.startsWith("~/")) abs = home + src.slice(1);
  else if (src.startsWith("/")) abs = src;
  else if (!/\s/.test(src) && /[/.]/.test(src)) abs = `${workspace}/${src}`;
  return h("li", {}, abs ? h("a", { href: `vscode://file${abs.split(/[:#]/)[0]}`, title: "Open in VS Code" }, src) : src);
}

function showDetails() {
  const panel = $("#details");
  const id = state.selected;
  const n = id && node(id);
  if (!n) {
    typing += 1;
    panel.hidden = true;
    return;
  }
  const chain = ancestry(state.index, id).slice(0, -1);
  const kidsOf = state.index.children.get(id) ?? [];
  const open = state.expanded.has(id);
  const isGroup = hasChildren(id) && open;
  const rels = relationsOf(id);
  const story = narrate(n.label, rels.map((r) => ({ dir: r.dir, kind: r.kind, other: node(r.other)?.label ?? r.other })));
  const title = h("h2", { class: "hud-title", style: `--glow:${colorOf(id)}` });
  const prose = h("p", { class: "narrative" });
  const outCount = new Set(rels.filter((r) => r.dir === "out").map((r) => r.other)).size;
  const inCount = new Set(rels.filter((r) => r.dir === "in").map((r) => r.other)).size;

  fill(panel,
    h("button", { class: "ghost close", "aria-label": "Close", onclick: clearSelection }, "✕"),
    h("div", { class: "kicker" }, [isGroup ? "GROUP" : "FOCUS", n.kind, layerOf(id)].filter(Boolean).join(" · ").toUpperCase()),
    chain.length > 1 ? h("div", { class: "crumbs" }, chain.slice(1).map((a, i) => [i ? "›" : null, h("button", { type: "button", class: "crumb", onclick: () => reveal(a) }, node(a).label)])) : null,
    title,
    h("div", { class: "badges" },
      n.status ? h("span", { class: `badge ${n.status}` }, n.status) : null,
      n.confidence ? h("span", { class: `badge ${n.confidence}` }, n.confidence) : null,
      h("span", { class: "badge" }, `→ ${outCount}  ← ${inCount}`),
      kidsOf.length ? h("span", { class: "badge" }, `${descendantCount(state.index, id)} inside`) : null),
    prose,
    h("div", { class: "actions" },
      h("button", { class: "primary", onclick: () => openChat({ prefill: `Brief me on ${n.label}: what it does, what it depends on, what depends on it, and what would break without it.` }) }, "Ask Claude"),
      kidsOf.length ? h("button", { onclick: () => toggle(id) }, open ? "Collapse" : `Open (${kidsOf.length})`) : null,
      focus.canGoBack() ? h("button", { onclick: goBack }, "◂ Back") : null),
    relationChips(rels, "out"),
    relationChips(rels, "in"),
    kidsOf.length ? [h("h3", {}, `Inside (${kidsOf.length})`), h("div", { class: "chips" }, kidsOf.map((c) => h("button", { type: "button", class: "chip", style: `--chip:${colorOf(c)}`, onclick: () => reveal(c) }, node(c).label)))] : null,
    h("details", { class: "facts" },
      h("summary", {}, "Facts & sources"),
      n.summary ? h("p", {}, n.summary) : null,
      n.details?.length ? h("ul", {}, n.details.map((d) => h("li", {}, d))) : null,
      n.links?.length ? [h("h3", {}, "Links"), h("ul", {}, n.links.map((l) => h("li", {}, h("a", { href: l.url, target: "_blank", rel: "noopener noreferrer" }, l.label || l.url))))] : null,
      n.sources?.length ? [h("h3", {}, "Sources"), h("ul", { class: "sources" }, n.sources.map(sourceItem))] : null,
      h("p", { class: "muted", style: "font-size:11px" }, `id ${id} · data/${n.files.join(", data/")}`)),
  );
  if (panel.dataset.id !== id) panel.scrollTop = 0;
  panel.dataset.id = id;
  panel.hidden = false;
  const finish = typeOut([{ el: title, text: n.label }, { el: prose, text: (n.summary ? [n.summary] : []).concat(story).join(" ") }]);
  panel.onclick = (ev) => {
    if (!ev.target.closest("a, button, summary")) finish?.();
  };
}

function showIssues() {
  clearSelection();
  const panel = $("#details");
  fill(panel,
    h("button", { class: "ghost close", "aria-label": "Close", onclick: () => (panel.hidden = true) }, "✕"),
    h("div", { class: "kicker" }, "DATA"),
    h("h2", { class: "hud-title" }, "Data issues"),
    h("p", { class: "muted" }, "From merging data/*.json. Run npm run check for the same list."),
    h("ul", { class: "sources" }, state.stack.issues.map((i) => h("li", {}, `${i.level} · ${i.file}: ${i.message}`))),
  );
  panel.dataset.id = "";
  panel.scrollTop = 0;
  panel.hidden = false;
}

// ---------- search ----------

function setupSearch() {
  const input = $("#search");
  const list = $("#search-results");
  let results = [];
  let active = 0;
  const pathOf = (id) => ancestry(state.index, id).slice(0, -1).map((a) => node(a).label).join(" › ");
  const score = (n, q) => {
    const label = n.label.toLowerCase();
    if (label.startsWith(q)) return 4;
    if (label.includes(q)) return 3;
    if (n.id.includes(q)) return 2;
    if ((n.summary ?? "").toLowerCase().includes(q) || (n.details ?? []).some((d) => d.toLowerCase().includes(q))) return 1;
    return 0;
  };
  const draw = () => {
    list.replaceChildren(...results.map((n, i) =>
      h("li", { role: "option", "aria-selected": String(i === active), onmousedown: (ev) => { ev.preventDefault(); choose(i); } },
        h("span", {}, n.label), h("span", { class: "path" }, pathOf(n.id)), h("span", { class: "kind" }, n.kind))));
    list.hidden = !results.length;
  };
  const choose = (i) => {
    const n = results[i];
    if (!n) return;
    input.value = "";
    results = [];
    draw();
    input.blur();
    reveal(n.id);
  };
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    results = q
      ? state.stack.nodes.map((n) => [n, score(n, q)]).filter(([, s]) => s).sort((a, b) => b[1] - a[1] || a[0].label.localeCompare(b[0].label)).slice(0, 10).map(([n]) => n)
      : [];
    active = 0;
    draw();
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") { active = Math.min(active + 1, results.length - 1); draw(); ev.preventDefault(); }
    else if (ev.key === "ArrowUp") { active = Math.max(active - 1, 0); draw(); ev.preventDefault(); }
    else if (ev.key === "Enter") choose(active);
    else if (ev.key === "Escape") { input.value = ""; results = []; draw(); input.blur(); }
  });
  input.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 100));
  input.addEventListener("focus", () => (list.hidden = !results.length));
}

// ---------- legend, status, tooltip, background ----------

function buildLegend() {
  const legend = $("#legend");
  const layerRows = Object.entries(LAYER_COLORS).map(([id, c]) => h("div", { class: "row" }, h("span", { class: "sw", style: `background:${c};box-shadow:0 0 8px ${c}` }), node(id)?.label ?? id));
  const edgeRows = Object.values(EDGE_GROUPS).map((g) => h("div", { class: "row" }, h("span", { class: "ln", style: `border-color:${g.color}` }), g.label));
  fill(legend,
    h("h4", {}, "Colour = layer"), layerRows,
    h("h4", {}, "Lines = relation"), edgeRows,
    h("div", { class: "row" }, h("span", { class: "ln", style: "border-top-style:dashed;border-color:#7f93c4" }), "deployed on (dashed)"),
    h("h4", {}, "Shape = kind"),
    h("p", {}, "▢ platform / project / service · ⬡ agent / bot · ◇ cron job · ⛁ database · ⬠ skill · ▱ config / doc · ◯ external / channel · ★ person"),
    h("h4", {}, "Moves"),
    h("p", {}, "Click: fly in — uses orbit right, used-by left, light flows the way the relation points. Click a neighbour or chip: travel. Double-click a group: open/close. Esc: fly out. Backspace: back."),
  );
  const btn = $("#btn-legend");
  btn.addEventListener("click", () => {
    legend.hidden = !legend.hidden;
    btn.setAttribute("aria-expanded", String(!legend.hidden));
  });
}

function buildStatus() {
  const { nodes, edges, issues } = state.stack;
  const errors = issues.filter((i) => i.level === "error").length;
  fill($("#status"),
    h("span", { class: "live" }), `${nodes.length} systems · ${edges.length} relations · click to fly in · Esc to fly out`,
    issues.length ? h("button", { onclick: showIssues }, `${errors} errors, ${issues.length - errors} warnings`) : null,
  );
  fill($("#intro .sub"), `${nodes.length} systems · ${edges.length} relations`);
}

function setupTooltip() {
  const tip = h("div", { class: "card tip", hidden: true });
  document.body.append(tip);
  cy.on("mouseover", "node", (ev) => {
    const n = node(ev.target.id());
    if (!n || ev.target.hasClass("hero")) return;
    const collapsed = ev.target.hasClass("collapsed");
    fill(tip, h("strong", {}, n.label), n.summary ? h("div", {}, n.summary.length > 180 ? `${n.summary.slice(0, 180)}…` : n.summary) : null,
      h("div", { class: "muted" }, collapsed ? "Click to fly in · double-click to open" : "Click to fly in"));
    const p = ev.renderedPosition;
    tip.style.left = `${Math.min(p.x + 16, innerWidth - 300)}px`;
    tip.style.top = `${p.y + 16}px`;
    tip.hidden = false;
    cy.container().style.cursor = "pointer";
    ev.target.connectedEdges(".beam").addClass("hover");
  });
  cy.on("mouseout", "node", (ev) => {
    tip.hidden = true;
    cy.container().style.cursor = "";
    ev.target.connectedEdges().removeClass("hover");
  });
  cy.on("mouseover", "edge", (ev) => ev.target.addClass("hover"));
  cy.on("mouseout", "edge", (ev) => ev.target.removeClass("hover"));
  cy.on("viewport", () => (tip.hidden = true));
}

// The star field drifts a little slower than the map, which reads as depth.
function setupParallax() {
  const root = document.documentElement.style;
  cy.on("viewport", () => {
    const { x, y } = cy.pan();
    root.setProperty("--px", `${(x * 0.12).toFixed(1)}px`);
    root.setProperty("--py", `${(y * 0.12).toFixed(1)}px`);
  });
}

// ---------- boot ----------

async function main() {
  const res = await fetch("/api/stack");
  state.stack = await res.json();
  state.index = buildIndex(state.stack);
  state.expanded = defaultExpanded();

  cy = cytoscape({ container: $("#cy"), style: cyStyle(), minZoom: 0.08, maxZoom: 3, boxSelectionEnabled: false, selectionType: "single" });
  focus = createFocus(cy, { insets });

  cy.on("tap", "node", (ev) => select(ev.target.id()));
  cy.on("dbltap", "node", (ev) => toggle(ev.target.id()));
  cy.on("tap", (ev) => {
    if (ev.target === cy && state.selected) clearSelection();
  });

  $("#btn-expand").addEventListener("click", () => {
    state.expanded = new Set(state.stack.nodes.filter((n) => hasChildren(n.id)).map((n) => n.id));
    state.selected = null;
    showDetails();
    render().then(() => focus.camera(boxAll()));
  });
  $("#btn-collapse").addEventListener("click", () => {
    state.expanded = defaultExpanded();
    state.selected = null;
    showDetails();
    render().then(() => focus.camera(boxAll()));
  });
  $("#btn-fit").addEventListener("click", () => focus.camera(boxAll()));
  document.addEventListener("keydown", (ev) => {
    if (/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
    if (ev.key === "Escape") clearSelection();
    else if (ev.key === "Backspace" && focus.active()) { ev.preventDefault(); goBack(); }
    else if (ev.key === "/") { ev.preventDefault(); $("#search").focus(); }
  });

  setupSearch();
  buildLegend();
  buildStatus();
  setupTooltip();
  setupParallax();
  initChat({
    models: state.stack.meta.models,
    getFocus: () => state.selected,
    labelOf: (id) => node(id)?.label,
    onNodeLink: (id) => reveal(id),
    clearFocus: clearSelection,
  });
  await render({ intro: true });
}

function boxAll() {
  const bb = cy.elements().boundingBox();
  return { x1: bb.x1, y1: bb.y1, w: bb.w, h: bb.h };
}

main().catch((err) => {
  console.error(err);
  document.body.append(h("div", { class: "card", style: "position:fixed;top:40%;left:50%;transform:translate(-50%,-50%);padding:16px" }, `Could not load the map: ${err.message}`));
});
