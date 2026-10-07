// Pure graph logic shared by the browser (app.js) and the tests. No DOM, no Cytoscape.
//
// The stack is a tree (node.parent) plus cross-links (edges). The map only shows the part
// of the tree the user has expanded; every edge is drawn between the nearest *visible*
// ancestors of its endpoints, so collapsing Hermes turns "hermes-gateway → zb-hermes-eu"
// into "Hermes → Zeabur" instead of hiding it.

export function buildIndex(stack) {
  const byId = new Map(stack.nodes.map((n) => [n.id, n]));
  const children = new Map();
  for (const n of stack.nodes) {
    if (!n.parent) continue;
    if (!children.has(n.parent)) children.set(n.parent, []);
    children.get(n.parent).push(n.id);
  }
  return { byId, children, edges: stack.edges };
}

// [root, ..., parent, id]
export function ancestry(index, id) {
  const chain = [];
  for (let cur = id; cur; cur = index.byId.get(cur)?.parent) chain.unshift(cur);
  return chain;
}

export function descendantCount(index, id) {
  let total = 0;
  for (const c of index.children.get(id) ?? []) total += 1 + descendantCount(index, c);
  return total;
}

// The node that stands in for `id` on screen: the first collapsed node on its path from
// the root, or the node itself when every ancestor is expanded.
export function representative(index, id, expanded) {
  const chain = ancestry(index, id);
  for (let i = 0; i < chain.length - 1; i++) if (!expanded.has(chain[i])) return chain[i];
  return id;
}

export function visibleNodeIds(index, expanded) {
  return [...index.byId.keys()].filter((id) => representative(index, id, expanded) === id);
}

// Every edge re-pointed at visible nodes. Edges that end up inside a single collapsed
// node are dropped (they are internal to it).
export function liftEdges(index, expanded) {
  const lifted = [];
  for (const e of index.edges) {
    const source = representative(index, e.source, expanded);
    const target = representative(index, e.target, expanded);
    if (source === target) continue;
    lifted.push({ source, target, kind: e.kind, label: e.label, edges: [e] });
  }
  return mergeLiftedEdges(lifted);
}

// When groups are collapsed, many real edges land on the same pair of visible nodes
// (e.g. eight Hermes cron jobs that all "notify" Telegram). This decides how they are drawn.
//
// Input: one entry per real edge, { source, target, kind, label, edges: [originalEdge] }.
// Output: the entries to draw. Each output entry must keep `source`, `target`, `kind`,
// `label` and `edges` (the original edges it stands for — the details panel lists them).
//
// Policy: one line per direction of a pair (Hermes → Zeabur and Zeabur → Hermes stay apart).
// The line takes the most common kind (its colour and dash) and its label lists every kind,
// so the map stays calm and the meaning survives on hover; thickness shows the count.
export function mergeLiftedEdges(lifted) {
  const pairs = new Map();
  for (const e of lifted) {
    const key = `${e.source}|${e.target}`;
    if (pairs.has(key)) pairs.get(key).edges.push(...e.edges);
    else pairs.set(key, { source: e.source, target: e.target, edges: [...e.edges] });
  }
  return [...pairs.values()].map((p) => {
    if (p.edges.length === 1) return { ...p, kind: p.edges[0].kind, label: p.edges[0].label };
    const counts = new Map();
    for (const e of p.edges) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    const kinds = [...counts].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    return { ...p, kind: kinds[0], label: kinds.join(" · ") };
  });
}
