// Saved activity: one JSON signal per line in a gitignored file, so a restart keeps the history.
// Loading drops what is older than `days` and rewrites the file trimmed. Every failure is
// logged and ignored: the map works without it.
import { appendFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DAY = 86_400_000;
const valid = (s) => s && typeof s.id === "string" && typeof s.node === "string" && typeof s.text === "string" && Number.isFinite(s.at);

export function loadActivity(file, days, now = Date.now()) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file)) return [];
    const kept = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      try {
        const signal = JSON.parse(line);
        if (valid(signal) && signal.at >= now - days * DAY) kept.push(signal);
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
