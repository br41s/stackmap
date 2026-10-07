// Turns a node's relations into a short briefing: "Hermes runs on Zeabur, thinks with
// OpenRouter and reports to Telegram. Claude Code manages it." Pure: no DOM, no Cytoscape,
// so the tests can pin the wording.

// [outgoing verb, incoming singular, incoming plural] per relation kind.
const PHRASES = {
  "deployed-on": ["runs on", "runs on it", "run on it"],
  "depends-on": ["depends on", "depends on it", "depend on it"],
  calls: ["calls", "calls it", "call it"],
  reads: ["reads from", "reads from it", "read from it"],
  writes: ["writes to", "writes to it", "write to it"],
  "stores-in": ["stores data in", "stores data in it", "store data in it"],
  notifies: ["reports to", "reports to it", "report to it"],
  deploys: ["deploys", "deploys it", "deploy it"],
  manages: ["manages", "manages it", "manage it"],
  controls: ["controls", "controls it", "control it"],
  monitors: ["watches", "watches it", "watch it"],
  configures: ["configures", "configures it", "configure it"],
  "backs-up-to": ["backs up to", "backs up to it", "back up to it"],
  "uses-model": ["thinks with", "powers its thinking", "power its thinking"],
  "routes-to": ["routes to", "routes to it", "route to it"],
  serves: ["serves", "serves it", "serve it"],
};
const phrase = (kind) => PHRASES[kind] ?? ["is linked to", "is linked to it", "are linked to it"];

// "A", "A and B", "A, B and C", "A, B, C and 2 more"
export function listOf(names, max = 3) {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  if (shown.length < 2) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

// relations: [{ dir: "out" | "in", kind, other }] — `other` is the label shown on the map.
// Groups by direction and kind (most relations first), then writes at most `maxSentences`.
export function narrate(label, relations, { maxSentences = 4 } = {}) {
  if (!relations.length) return [`${label} has no relations on the map yet.`];
  const groups = new Map();
  for (const r of relations) {
    const key = `${r.dir}|${r.kind}`;
    if (!groups.has(key)) groups.set(key, { dir: r.dir, kind: r.kind, others: [] });
    const g = groups.get(key);
    if (!g.others.includes(r.other)) g.others.push(r.other);
  }
  const ranked = [...groups.values()].sort((a, b) => b.others.length - a.others.length);
  const outs = ranked.filter((g) => g.dir === "out");
  const ins = ranked.filter((g) => g.dir === "in");

  const sentences = [];
  // Outgoing: one sentence with up to three clauses, the subject said once.
  if (outs.length) {
    const clauses = outs.slice(0, 3).map((g) => `${phrase(g.kind)[0]} ${listOf(g.others)}`);
    sentences.push(`${label} ${listOf(clauses, 3)}.`);
  }
  // Incoming: one sentence per kind, the others are the subject.
  for (const g of ins) {
    if (sentences.length >= maxSentences) break;
    const [one, many] = phrase(g.kind).slice(1);
    const verb = g.others.length === 1 ? one : many;
    sentences.push(`${capitalize(listOf(g.others))} ${verb}.`);
  }
  // Leftover outgoing kinds that did not fit in the first sentence.
  for (const g of outs.slice(3)) {
    if (sentences.length >= maxSentences) break;
    sentences.push(`It also ${phrase(g.kind)[0]} ${listOf(g.others)}.`);
  }
  return sentences;
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
