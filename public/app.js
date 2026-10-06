// The map: loads /api/stack, draws the expanded part of the tree with Cytoscape + fcose,
// and wires search, the details panel and the chat to it.
import { buildIndex, ancestry, descendantCount, visibleNodeIds, liftEdges } from "./graph-model.js";
import { initChat, openChat } from "./chat.js";

const LAYER_COLORS = {
  "layer-hosting": "#4F8EF7",
  "layer-agents": "#A66CFF",
  "layer-dev": "#F2A93B",
  "layer-products": "#2FBF71",
  "layer-external": "#8A94A6",
};
const ROOT_COLOR = "#F25F5C"; // nodes outside the layers (Brais)
const SHAPES = {
  layer: "round-rectangle", platform: "round-rectangle", project: "round-rectangle", service: "round-rectangle",
  server: "cut-rectangle", database: "barrel", agent: "round-hexagon", bot: "round-hexagon",
  "cron-job": "round-diamond", tool: "round-tag", "mcp-server": "round-tag", skill: "round-pentagon",
  hook: "round-triangle", config: "rhomboid", doc: "rhomboid", repo: "bottom-round-rectangle",
  domain: "tag", channel: "ellipse", external: "ellipse", person: "star",
};
const EDGE_GROUPS = {
  runtime: { color: "#7d8ca8", label: "runs on / serves / stores in / depends on", kinds: ["deployed-on", "serves", "stores-in", "depends-on"] },
  data: { color: "#1fb5c9", label: "calls / reads / writes / uses model / routes", kinds: ["calls", "reads", "writes", "uses-model", "routes-to"] },
  notify: { color: "#e86fa6", label: "notifies", kinds: ["notifies"] },
  control: { color: "#e0a030", label: "deploys / manages / monitors / configures / backs up", kinds: ["deploys", "manages", "controls", "monitors", "configures", "backs-up-to"] },
};
const edgeGroup = (kind) => Object.keys(EDGE_GROUPS).find((g) => EDGE_GROUPS[g].kinds.includes(kind)) ?? "runtime";

const $ = (sel) => document.querySelector(sel);
const state = { stack: null, index: null, expanded: new Set(), selected: null, focusOnly: false, laidOut: false, lifted: new Map() };
let cy;

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
const descendants = (id) => (state.index.children.get(id) ?? []).flatMap((c) => [c, ...descendants(c)]);
const defaultExpanded = () => new Set(state.stack.nodes.filter((n) => n.kind === "layer" && hasChildren(n.id)).map((n) => n.id));

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function cyStyle() {
  const text = cssVar("--text");
  const bg = cssVar("--bg");
  const accent = cssVar("--accent");
  return [
    { selector: "node", style: {
      "background-color": "data(color)", "background-opacity": 0.92, shape: (el) => SHAPES[el.data("kind")] ?? "round-rectangle",
      width: "data(size)", height: "data(size)",
      label: "data(label)", color: text, "font-size": 12, "font-weight": 500, "text-valign": "bottom", "text-margin-y": 5,
      "text-wrap": "wrap", "text-max-width": 130, "text-outline-color": bg, "text-outline-width": 2.5, "min-zoomed-font-size": 6,
    } },
    { selector: "node.collapsed", style: {
      "outline-width": 4, "outline-offset": 2, "outline-color": "data(color)", "outline-opacity": 0.35,
      "font-weight": 600, "font-size": 15,
    } },
    { selector: "node.group", style: {
      shape: "round-rectangle", "background-opacity": 0.07, "border-width": 1.5, "border-color": "data(color)", "border-opacity": 0.55,
      "text-valign": "top", "text-margin-y": -6, "font-size": 15, "font-weight": 600, padding: 18,
    } },
    { selector: "node.layer.group", style: { "border-style": "dashed", "font-size": 22, "text-transform": "uppercase", padding: 30, "background-opacity": 0.035 } },
    { selector: "node.retired", style: { opacity: 0.42 } },
    { selector: "node.planned, node.dry-run", style: { "border-width": 2, "border-style": "dashed", "border-color": text, "border-opacity": 0.6 } },
    { selector: "node.inferred", style: { "font-style": "italic" } },
    { selector: "node.sel", style: { "underlay-color": accent, "underlay-padding": 7, "underlay-opacity": 0.35 } },
    { selector: "node.sel.group", style: { "underlay-opacity": 0, "border-width": 3, "border-color": accent, "border-opacity": 0.9 } },
    { selector: "edge", style: {
      width: "mapData(weight, 1, 12, 1.3, 5)", "line-color": "data(color)", "target-arrow-color": "data(color)",
      "target-arrow-shape": "triangle", "arrow-scale": 0.8, "curve-style": "bezier", "control-point-step-size": 16, opacity: 0.5,
    } },
    { selector: 'edge[kind = "deployed-on"]', style: { "line-style": "dashed", "line-dash-pattern": [6, 4] } },
    { selector: "edge.hl", style: { opacity: 0.95, "z-index": 10 } },
    // Labels only on hover: on a selected hub they would pile up on the short edges.
    { selector: "edge.hover", style: {
      opacity: 1, label: "data(label)", "font-size": 11, color: text, "text-rotation": "autorotate",
      "text-outline-color": bg, "text-outline-width": 3, "z-index": 20, width: 3,
    } },
    { selector: "node.faded", style: { opacity: 0.16 } },
    { selector: "edge.faded", style: { opacity: 0.05 } },
    { selector: "edge.off", style: { display: "none" } },
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
    return {
      group: "edges",
      data: { id, source: e.source, target: e.target, kind: e.kind, color: EDGE_GROUPS[edgeGroup(e.kind)].color, weight, label: weight > 1 ? `${e.label} (${weight})` : e.label },
    };
  });
  return [...nodes, ...edges];
}

function render({ fitTo } = {}) {
  cy.batch(() => {
    cy.elements().remove();
    cy.add(elementsFor());
  });
  highlight();
  return new Promise((resolve) => {
    const first = !state.laidOut;
    const layout = cy.layout({
      name: "fcose", quality: "default", randomize: first, animate: !first, animationDuration: 450, fit: first, padding: 60,
      nodeDimensionsIncludeLabels: true, nodeRepulsion: 9000, idealEdgeLength: 110, edgeElasticity: 0.25, nestingFactor: 0.5,
      gravity: 0.35, gravityCompound: 1.4, gravityRangeCompound: 1.6, tile: true, tilingPaddingVertical: 24, tilingPaddingHorizontal: 24, numIter: 2500,
    });
    layout.one("layoutstop", () => {
      state.laidOut = true;
      if (fitTo) frame(fitTo);
      resolve();
    });
    layout.run();
  });
}

// Bring a node and everything inside it into view, without zooming in further than 1.3.
function frame(id) {
  const el = cy.getElementById(id);
  if (el.empty()) return;
  const eles = el.union(el.descendants());
  const bb = eles.boundingBox({ includeLabels: true });
  const pad = 90;
  const zoom = Math.min(1.3, (cy.width() - 2 * pad) / Math.max(bb.w, 1), (cy.height() - 2 * pad) / Math.max(bb.h, 1));
  cy.animate({ zoom: Math.max(zoom, cy.minZoom()), center: { eles } }, { duration: 350 });
}

function highlight() {
  cy.elements().removeClass("faded hl off sel");
  const el = state.selected && cy.getElementById(state.selected);
  if (!el || el.empty()) return;
  const group = el.union(el.descendants());
  const edges = group.connectedEdges();
  const ends = edges.connectedNodes().union(group);
  const keep = ends.union(ends.ancestors()).union(edges);
  el.addClass("sel");
  edges.addClass("hl");
  const rest = cy.elements().not(keep);
  rest.addClass("faded");
  if (state.focusOnly) rest.edges().addClass("off");
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

function select(id) {
  state.selected = id;
  highlight();
  showDetails();
}

// Make a node visible (expand its ancestors), select it and bring it into view.
async function reveal(id) {
  if (!node(id)) return;
  const chain = ancestry(state.index, id).slice(0, -1);
  const missing = chain.filter((a) => !state.expanded.has(a));
  state.selected = id;
  if (missing.length) {
    missing.forEach((a) => state.expanded.add(a));
    await render({ fitTo: id });
  } else {
    highlight();
    frame(id);
  }
  showDetails();
}

// ---------- details panel ----------

function sourceItem(src) {
  const { workspace, home } = state.stack.meta;
  let abs = null;
  if (src.startsWith("~/")) abs = home + src.slice(1);
  else if (src.startsWith("/")) abs = src;
  else if (!/\s/.test(src) && /[/.]/.test(src)) abs = `${workspace}/${src}`;
  return h("li", {}, abs ? h("a", { href: `vscode://file${abs.split(/[:#]/)[0]}`, title: "Open in VS Code" }, src) : src);
}

function relationList(id) {
  const inside = new Set([id, ...descendants(id)]);
  const out = [];
  const inc = [];
  for (const e of state.stack.edges) {
    const s = inside.has(e.source);
    const t = inside.has(e.target);
    if (s && !t) out.push({ e, other: e.target, via: e.source !== id ? e.source : null });
    else if (t && !s) inc.push({ e, other: e.source, via: e.target !== id ? e.target : null });
  }
  const item = ({ e, other, via }) =>
    h("li", { title: [e.label, e.note].filter(Boolean).join(" — ") },
      h("span", { class: "k" }, e.kind),
      h("span", {},
        h("a", { onclick: () => reveal(other) }, node(other)?.label ?? other),
        via ? h("span", { class: "via" }, ` · via ${node(via)?.label ?? via}`) : null));
  const section = (title, rows) => {
    if (!rows.length) return null;
    rows.sort((a, b) => a.e.kind.localeCompare(b.e.kind));
    const shown = rows.slice(0, 60);
    return [h("h3", {}, `${title} (${rows.length})`), h("ul", { class: "rel" }, shown.map(item)), rows.length > shown.length ? h("p", { class: "muted" }, `…and ${rows.length - shown.length} more`) : null];
  };
  return [section("Uses / points to", out), section("Used by", inc)];
}

function showDetails() {
  const panel = $("#details");
  const id = state.selected;
  const n = id && node(id);
  if (!n) {
    panel.hidden = true;
    return;
  }
  const chain = ancestry(state.index, id).slice(0, -1);
  const kids = state.index.children.get(id) ?? [];
  const open = state.expanded.has(id);
  fill(panel, 
    h("button", { class: "ghost close", "aria-label": "Close details", onclick: () => { state.selected = null; highlight(); showDetails(); } }, "✕"),
    chain.length ? h("div", { class: "crumbs" }, chain.map((a, i) => [i ? "›" : null, h("a", { onclick: () => reveal(a) }, node(a).label)])) : null,
    h("h2", {}, h("span", { class: "dot", style: `background:${colorOf(id)}` }), n.label),
    h("div", { class: "badges" },
      h("span", { class: "badge" }, n.kind),
      n.status ? h("span", { class: `badge ${n.status}` }, n.status) : null,
      n.confidence ? h("span", { class: `badge ${n.confidence}` }, n.confidence) : null,
      kids.length ? h("span", { class: "badge" }, `${descendantCount(state.index, id)} inside`) : null),
    n.summary ? h("p", { class: "summary" }, n.summary) : null,
    n.details?.length ? h("ul", {}, n.details.map((d) => h("li", {}, d))) : null,
    h("div", { class: "actions" },
      h("button", { class: "primary", onclick: () => openChat({ prefill: `What is ${n.label}, what does it depend on, and what depends on it?` }) }, "Ask about this"),
      kids.length ? h("button", { onclick: () => toggle(id) }, open ? "Collapse" : `Expand (${kids.length})`) : null,
      h("button", { onclick: () => reveal(id) }, "Center")),
    kids.length ? [h("h3", {}, `Contains (${kids.length})`), h("div", { class: "chips" }, kids.map((c) => h("a", { onclick: () => reveal(c) }, node(c).label)))] : null,
    relationList(id),
    n.links?.length ? [h("h3", {}, "Links"), h("ul", {}, n.links.map((l) => h("li", {}, h("a", { href: l.url, target: "_blank", rel: "noopener noreferrer" }, l.label || l.url))))] : null,
    n.sources?.length ? [h("h3", {}, "Sources"), h("ul", { class: "sources" }, n.sources.map(sourceItem))] : null,
    h("p", { class: "muted", style: "font-size:11px;margin-top:14px" }, `id ${id} · data/${n.files.join(", data/")}`),
  );
  if (panel.dataset.id !== id) panel.scrollTop = 0;
  panel.dataset.id = id;
  panel.hidden = false;
}

function showIssues() {
  state.selected = null;
  highlight();
  const panel = $("#details");
  fill(panel, 
    h("button", { class: "ghost close", "aria-label": "Close", onclick: () => (panel.hidden = true) }, "✕"),
    h("h2", {}, "Data issues"),
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
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "/" && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) { ev.preventDefault(); input.focus(); }
  });
}

// ---------- legend, status, tooltip ----------

function buildLegend() {
  const legend = $("#legend");
  const layerRows = Object.entries(LAYER_COLORS).map(([id, c]) => h("div", { class: "row" }, h("span", { class: "sw", style: `background:${c}` }), node(id)?.label ?? id));
  const edgeRows = Object.values(EDGE_GROUPS).map((g) => h("div", { class: "row" }, h("span", { class: "ln", style: `border-color:${g.color}` }), g.label));
  fill(legend, 
    h("h4", {}, "Colour = layer"), layerRows,
    h("h4", {}, "Lines = relation"), edgeRows,
    h("div", { class: "row" }, h("span", { class: "ln", style: "border-top-style:dashed;border-color:#7d8ca8" }), "deployed on (dashed)"),
    h("h4", {}, "Shape = kind"),
    h("p", {}, "▢ platform / project / service · ⬡ agent / bot · ◇ cron job · ⛁ database · ⬠ skill · ▱ config / doc · ◯ external / channel · ★ person"),
    h("h4", {}, "Marks"),
    h("p", {}, "Glow ring + “+N” = collapsed group, double-click to open. Faded = retired. Dashed border = planned or dry-run. Italic = inferred, not confirmed in a file."),
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
    `${nodes.length} nodes · ${edges.length} relations · double-click a group to open it`,
    issues.length ? h("button", { onclick: showIssues }, `${errors} errors, ${issues.length - errors} warnings`) : null,
  );
}

function setupTooltip() {
  const tip = h("div", { class: "card", style: "position:fixed;pointer-events:none;padding:8px 10px;max-width:280px;font-size:12px;z-index:5", hidden: true });
  document.body.append(tip);
  cy.on("mouseover", "node", (ev) => {
    const n = node(ev.target.id());
    if (!n) return;
    const collapsed = ev.target.hasClass("collapsed");
    fill(tip, h("strong", {}, n.label), n.summary ? h("div", {}, n.summary.length > 180 ? `${n.summary.slice(0, 180)}…` : n.summary) : null,
      collapsed ? h("div", { class: "muted" }, "Double-click to open") : null);
    const p = ev.renderedPosition;
    tip.style.left = `${Math.min(p.x + 16, innerWidth - 300)}px`;
    tip.style.top = `${p.y + 16}px`;
    tip.hidden = false;
    cy.container().style.cursor = "pointer";
  });
  cy.on("mouseout", "node", () => { tip.hidden = true; cy.container().style.cursor = ""; });
  cy.on("mouseover", "edge", (ev) => ev.target.addClass("hover"));
  cy.on("mouseout", "edge", (ev) => ev.target.removeClass("hover"));
  cy.on("viewport", () => (tip.hidden = true));
}

// ---------- boot ----------

async function main() {
  const res = await fetch("/api/stack");
  state.stack = await res.json();
  state.index = buildIndex(state.stack);
  state.expanded = defaultExpanded();

  cy = cytoscape({ container: $("#cy"), style: cyStyle(), minZoom: 0.08, maxZoom: 3, boxSelectionEnabled: false, selectionType: "single" });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => cy.style(cyStyle()));

  cy.on("tap", "node", (ev) => select(ev.target.id()));
  cy.on("dbltap", "node", (ev) => toggle(ev.target.id()));
  cy.on("tap", (ev) => {
    if (ev.target === cy && state.selected) { state.selected = null; highlight(); showDetails(); }
  });

  $("#btn-expand").addEventListener("click", () => {
    state.expanded = new Set(state.stack.nodes.filter((n) => hasChildren(n.id)).map((n) => n.id));
    render().then(() => cy.animate({ fit: { padding: 60 } }, { duration: 300 }));
  });
  $("#btn-collapse").addEventListener("click", () => {
    state.expanded = defaultExpanded();
    if (state.selected) state.selected = ancestry(state.index, state.selected).find((a) => !state.expanded.has(a)) ?? state.selected;
    render().then(() => cy.animate({ fit: { padding: 60 } }, { duration: 300 }));
    showDetails();
  });
  $("#btn-fit").addEventListener("click", () => cy.animate({ fit: { padding: 60 } }, { duration: 300 }));
  $("#tgl-focus").addEventListener("change", (ev) => { state.focusOnly = ev.target.checked; highlight(); });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) { state.selected = null; highlight(); showDetails(); }
  });

  setupSearch();
  buildLegend();
  buildStatus();
  setupTooltip();
  initChat({
    model: state.stack.meta.model,
    getFocus: () => state.selected,
    labelOf: (id) => node(id)?.label,
    onNodeLink: (id) => reveal(id),
    clearFocus: () => { state.selected = null; highlight(); showDetails(); },
  });
  await render();
}

main().catch((err) => {
  console.error(err);
  document.body.append(h("div", { class: "card", style: "position:fixed;top:40%;left:50%;transform:translate(-50%,-50%);padding:16px" }, `Could not load the map: ${err.message}`));
});
