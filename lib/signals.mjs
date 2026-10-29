// Agent signals: short "something happened" pings that light up a node on the map.
// Kept in memory only (the last KEEP) — never written to data/, which stays the map's
// source of truth. Pure apart from the subscriber callbacks; server.mjs owns the HTTP side.
import { isAbsolute, join, normalize, sep } from "node:path";

const MAX_TEXT = 140;
const KEEP = 50;
export const KINDS = ["done", "waiting", "info"];

// Workspace folder → the node that stands for it. Longest match wins, so a worktree inside a
// repo (biglobster/.worktrees/x) still counts as that repo. `~/…` is the home folder; anything
// else under the workspace falls back to vscode-workspace, anything outside to claude-code.
// npm test fails if an id here leaves the map.
export const FOLDERS = {
  FinView: "proj-finview",
  SocialAgenda: "proj-socialagenda",
  FlyWell: "proj-flywell",
  chatmemo: "proj-chatmemo",
  biglobster: "proj-biglobster",
  "bl-site-package": "proj-bl-site-package",
  "grow-shop/grow-shop-api": "proj-grow-shop-api",
  "grow-shop/grow-shop-landing": "proj-grow-shop-landing",
  "grow-shop": "proj-grow-shop",
  heclient: "proj-heclient",
  OfflinePics: "proj-offlinepics",
  "experiencianatural-home": "proj-experiencianatural-home",
  "hermes-sandbox": "hermes",
  "ai-infra/hf-hub": "hf-hub",
  "mcp-hub": "mcp-hub",
  "~/fizz": "fizz",
};

export function nodeForCwd(cwd, { workspace, home }) {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return null;
  const dir = normalize(cwd);
  const inside = (root) => dir === root || dir.startsWith(root + sep);
  let best = null;
  for (const [folder, id] of Object.entries(FOLDERS)) {
    const root = folder.startsWith("~/") ? join(home, folder.slice(2)) : join(workspace, folder);
    if (inside(root) && (!best || root.length > best.root.length)) best = { root, id };
  }
  if (best) return best.id;
  return inside(normalize(workspace)) ? "vscode-workspace" : "claude-code";
}

// Markdown → plain text: agents answer in markdown, the ticker shows text. Headings, list and
// quote markers, links and images (their text stays), code ticks, bold and italic. Single
// underscores stay, so snake_case names survive.
function plain(text) {
  return text
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.|>)[ \t]+/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/\*([^*\s][^*]*)\*/g, "$1");
}

// One line of plain text, no control characters, at most MAX_TEXT characters.
export function cleanText(text) {
  if (typeof text !== "string") return "";
  const line = plain(text).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return line.length > MAX_TEXT ? `${line.slice(0, MAX_TEXT - 1)}…` : line;
}

export function createSignals({ keep = KEEP } = {}) {
  const recent = [];
  const subscribers = new Set();
  const boot = Date.now().toString(36); // ids stay unique across server restarts
  let n = 0;
  return {
    add({ node, kind, text }) {
      const signal = { id: `${boot}-${++n}`, node, kind: KINDS.includes(kind) ? kind : "info", text, at: Date.now() };
      recent.push(signal);
      if (recent.length > keep) recent.shift();
      for (const fn of subscribers) fn(signal);
      return signal;
    },
    recent: () => [...recent],
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}
