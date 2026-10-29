// Saved activity: one JSON signal per line in a gitignored file, so a restart keeps the history.
// Loading trusts nothing in it: each entry goes through the same cleaning as a live signal, and
// one with an unknown kind, a node not on the map (`nodes`) or older than `days` is dropped; the
// file is rewritten with what is kept. Every failure is logged and ignored: the map works without it.
import { appendFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { KINDS, cleanDetail, cleanText } from "./signals.mjs";

const DAY = 86_400_000;
// The entry as a live signal would be, or null.
function restore(s, { nodes, since }) {
  if (!s || typeof s.id !== "string" || typeof s.node !== "string" || !KINDS.includes(s.kind) || !Number.isFinite(s.at)) return null;
  if (s.at < since || (nodes && !nodes.has(s.node))) return null;
  const text = cleanText(s.text);
  if (!text) return null;
  const signal = { id: s.id.slice(0, 64), node: s.node, kind: s.kind, text, at: s.at };
  const detail = cleanDetail(s.detail);
  if (detail && detail !== text) signal.detail = detail;
  return signal;
}

export function loadActivity(file, days, { now = Date.now(), nodes = null } = {}) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file)) return [];
    const kept = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      try {
        const signal = restore(JSON.parse(line), { nodes, since: now - days * DAY });
        if (signal) kept.push(signal);
      } catch {} // a blank or cut line
    }
    writeFileSync(file, kept.map((s) => `${JSON.stringify(s)}\n`).join(""));
    return kept;
  } catch (err) {
    console.warn(`[activity] not loaded: ${err.message}`);
    return [];
  }
}

export const saveTo = (file) => (signal) =>
  appendFile(file, `${JSON.stringify(signal)}\n`).catch((err) => console.warn(`[activity] not saved: ${err.message}`));
