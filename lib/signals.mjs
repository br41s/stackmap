// Agent signals: short "something happened" pings that light up a node on the map, each with
// the full message behind it. The last DAYS are kept (lib/activity.mjs saves them to a
// gitignored file) — never in data/, which stays the map's source of truth. Pure apart from
// the callbacks; server.mjs owns the HTTP side.
import { isAbsolute, join, normalize, sep } from "node:path";

const MAX_TEXT = 140;
const MAX_DETAIL = 2000;
const KEEP = 50;
export const DAYS = 14;
const DAY = 86_400_000;
export const KINDS = ["done", "waiting", "info"];
// Who did it, besides where. The office view seats one avatar per agent. A signal that does
// not say gets agentForNode(); the last two have no source on this machine yet — any script or
// adapter can POST {node, agent: "gemini" | "chatgpt", kind, text, detail} to /api/signal.
export const AGENTS = ["claude-code", "hermes", "buzz", "gemini", "chatgpt"];

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

// The full message behind a ping: plain text with its line breaks (at most one blank line in a
// row), at most MAX_DETAIL characters.
export function cleanDetail(text) {
  if (typeof text !== "string") return "";
  const body = plain(text.replace(/\r/g, ""))
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return body.length > MAX_DETAIL ? `${body.slice(0, MAX_DETAIL - 1)}…` : body;
}

// Only a known agent id; anything else is treated as not given.
export const cleanAgent = (agent) => (AGENTS.includes(agent) ? agent : null);

// The agent a node belongs to when the signal does not name one: Hermes and its Zeabur
// services, the Buzz relay and the Fizz bots, otherwise Claude Code (projects, workspace…).
export function agentForNode(node) {
  if (/^(hermes|zb-hermes)/.test(node)) return "hermes";
  if (/^(buzz|fizz)/.test(node)) return "buzz";
  return "claude-code";
}

const brief = ({ detail, ...signal }) => signal;

// Every signal of the last `days`, oldest first. `recent()` is the tail the ticker replays and
// subscribers get the same brief form (no detail); `forNodes()` is the history an activity card
// shows, details included. `history` is what a previous run saved; `onAdd` saves each new one.
export function createSignals({ keep = KEEP, days = DAYS, history = [], onAdd = () => {} } = {}) {
  // Saved entries from before agents existed get theirs from their node.
  const all = history.map((s) => (s.agent ? s : { ...s, agent: agentForNode(s.node) }));
  const subscribers = new Set();
  const boot = Date.now().toString(36); // ids stay unique across server restarts
  let n = 0;
  return {
    add({ node, kind, text, detail, agent }) {
      const signal = { id: `${boot}-${++n}`, node, agent: cleanAgent(agent) ?? agentForNode(node), kind: KINDS.includes(kind) ? kind : "info", text, at: Date.now() };
      if (detail && detail !== text) signal.detail = detail;
      all.push(signal);
      while (all.length && all[0].at < signal.at - days * DAY) all.shift();
      onAdd(signal);
      for (const fn of subscribers) fn(brief(signal));
      return signal;
    },
    recent: () => all.slice(-keep).map(brief),
    forNodes(ids, limit = 300) {
      const wanted = new Set(ids);
      const out = [];
      for (let i = all.length - 1; i >= 0 && out.length < limit; i--) if (wanted.has(all[i].node)) out.push(all[i]);
      return out;
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}
