// Loads data/*.json slices, merges them into one graph and reports what does not add up.
// The slices are the source of truth; nothing here writes back to them.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const NODE_KINDS = [
  "layer", "platform", "server", "project", "service", "database", "agent", "bot",
  "cron-job", "tool", "mcp-server", "skill", "hook", "config", "repo", "domain",
  "channel", "external", "person", "doc",
];
export const EDGE_KINDS = [
  "deployed-on", "depends-on", "calls", "reads", "writes", "stores-in", "notifies",
  "deploys", "manages", "monitors", "backs-up-to", "uses-model", "routes-to",
  "controls", "configures", "serves",
];

const union = (a = [], b = []) => {
  const seen = new Set(a.map((x) => JSON.stringify(x)));
  return [...a, ...b.filter((x) => !seen.has(JSON.stringify(x)))];
};

// core.json first so the canonical layer/person/external nodes keep their wording.
function sliceFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort((a, b) => (a === "core.json" ? -1 : b === "core.json" ? 1 : a.localeCompare(b)));
}

function isAncestor(nodes, maybeAncestor, id) {
  for (let p = nodes.get(id)?.parent; p; p = nodes.get(p)?.parent) if (p === maybeAncestor) return true;
  return false;
}

export function mergeSlices(slices) {
  const issues = [];
  const nodes = new Map();
  const edges = new Map();

  for (const { file, data } of slices) {
    for (const n of data.nodes ?? []) {
      if (!n.id || !n.label || !n.kind) {
        issues.push({ level: "error", file, message: `node missing id/label/kind: ${JSON.stringify(n).slice(0, 120)}` });
        continue;
      }
      const prev = nodes.get(n.id);
      if (!prev) {
        nodes.set(n.id, { ...n, parent: n.parent ?? null, files: [file] });
        continue;
      }
      // A node defined twice: first definition keeps its scalars, lists are unioned.
      if ((n.parent ?? null) !== prev.parent) {
        issues.push({ level: "warn", file, message: `${n.id}: parent "${n.parent}" ignored, keeps "${prev.parent}" from ${prev.files[0]}` });
      }
      for (const k of ["summary", "status", "confidence"]) if (!prev[k] && n[k]) prev[k] = n[k];
      for (const k of ["details", "links", "sources"]) prev[k] = union(prev[k], n[k]);
      prev.files.push(file);
    }
    for (const e of data.edges ?? []) {
      const key = `${e.source}|${e.target}|${e.kind}`;
      const prev = edges.get(key);
      if (prev) {
        prev.sources = union(prev.sources, e.sources);
        prev.files.push(file);
      } else {
        edges.set(key, { ...e, id: key, files: [file] });
      }
    }
  }

  for (const n of nodes.values()) {
    if (!NODE_KINDS.includes(n.kind)) issues.push({ level: "warn", file: n.files[0], message: `${n.id}: unknown kind "${n.kind}"` });
    if (n.parent && !nodes.has(n.parent)) {
      issues.push({ level: "error", file: n.files[0], message: `${n.id}: parent "${n.parent}" does not exist (moved to root)` });
      n.parent = null;
    }
  }
  for (const n of nodes.values()) {
    const seen = new Set([n.id]);
    for (let p = n.parent; p; p = nodes.get(p)?.parent) {
      if (seen.has(p)) {
        issues.push({ level: "error", file: n.files[0], message: `${n.id}: parent cycle through "${p}" (moved to root)` });
        n.parent = null;
        break;
      }
      seen.add(p);
    }
  }
  for (const [key, e] of edges) {
    const missing = [e.source, e.target].filter((id) => !nodes.has(id));
    if (missing.length) {
      issues.push({ level: "error", file: e.files[0], message: `edge ${e.source} -${e.kind}-> ${e.target}: unknown ${missing.join(", ")} (dropped)` });
      edges.delete(key);
    } else if (e.source === e.target) {
      issues.push({ level: "warn", file: e.files[0], message: `edge ${key} is a self-loop (dropped)` });
      edges.delete(key);
    } else if (isAncestor(nodes, e.source, e.target) || isAncestor(nodes, e.target, e.source)) {
      // Containment is already the hierarchy; as an edge it vanishes when the group collapses.
      issues.push({ level: "warn", file: e.files[0], message: `edge ${key} links a node to its own ancestor` });
    } else if (!EDGE_KINDS.includes(e.kind)) {
      issues.push({ level: "warn", file: e.files[0], message: `edge ${key}: unknown kind "${e.kind}"` });
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()], issues };
}

export function loadStack(dataDir) {
  const slices = sliceFiles(dataDir).map((file) => ({
    file,
    data: JSON.parse(readFileSync(join(dataDir, file), "utf8")),
  }));
  return mergeSlices(slices);
}
