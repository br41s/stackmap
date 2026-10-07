// What a refresh changed in the map: nodes and relations added, removed or edited, between
// two merged stacks. Pure, so the PR description it feeds is tested.

const facts = (n) => JSON.stringify([n.label, n.kind, n.parent ?? null, n.status, n.summary, n.details ?? []]);

export function diffStacks(before, after) {
  const was = new Map(before.nodes.map((n) => [n.id, n]));
  const now = new Map(after.nodes.map((n) => [n.id, n]));
  const edgeKey = (e) => `${e.source} -${e.kind}-> ${e.target}`;
  const wasEdges = new Set(before.edges.map(edgeKey));
  const nowEdges = new Set(after.edges.map(edgeKey));
  return {
    added: [...now.keys()].filter((id) => !was.has(id)),
    removed: [...was.keys()].filter((id) => !now.has(id)),
    changed: [...now.keys()].filter((id) => was.has(id) && facts(was.get(id)) !== facts(now.get(id))),
    statusChanged: [...now.keys()]
      .filter((id) => was.has(id) && was.get(id).status !== now.get(id).status)
      .map((id) => ({ id, from: was.get(id).status, to: now.get(id).status })),
    edgesAdded: [...nowEdges].filter((k) => !wasEdges.has(k)),
    edgesRemoved: [...wasEdges].filter((k) => !nowEdges.has(k)),
  };
}

export function diffMarkdown(d, labelOf = (id) => id) {
  const list = (ids) => ids.map((id) => `- \`${id}\` ${labelOf(id)}`).join("\n");
  const parts = [];
  if (d.added.length) parts.push(`**Added (${d.added.length})**\n${list(d.added)}`);
  if (d.removed.length) parts.push(`**Removed (${d.removed.length})**\n${list(d.removed)}`);
  if (d.statusChanged.length) parts.push(`**Status changed (${d.statusChanged.length})**\n${d.statusChanged.map((s) => `- \`${s.id}\` ${s.from} → ${s.to}`).join("\n")}`);
  const edited = d.changed.filter((id) => !d.statusChanged.some((s) => s.id === id));
  if (edited.length) parts.push(`**Facts updated (${edited.length})**\n${list(edited)}`);
  if (d.edgesAdded.length) parts.push(`**Relations added (${d.edgesAdded.length})**\n${d.edgesAdded.map((k) => `- ${k}`).join("\n")}`);
  if (d.edgesRemoved.length) parts.push(`**Relations removed (${d.edgesRemoved.length})**\n${d.edgesRemoved.map((k) => `- ${k}`).join("\n")}`);
  return parts.join("\n\n") || "No changes to the map.";
}
