// Signals from agents that cannot run the Claude Code hook. The Fizz bots run in containers and
// write status files into ~/fizz/salida, a folder shared with this Mac; Hermes runs on Zeabur
// and has a public liveness probe (/api/status: version, gateway state, health — no secrets).
// Pure diff/compare functions plus two pollers that hand signals to `add`.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// salida/<folder>/estado.md → the bot that writes it. Any other folder, and salida/estado.md
// itself, → the fleet. npm test fails if an id here leaves the map.
export const FIZZ_FOLDERS = {
  seo: "fizz-bot-seodesk",
  socialbot: "fizz-bot-socialbot",
  guionista: "fizz-bot-guionista",
  operaciones: "fizz-bot-fizz",
};
export const FIZZ_FLEET = "fizz-fleet";
export const HERMES_NODES = ["hermes", "hermes-gateway", "hermes-dashboard"];

// The lines of `after` that `before` did not have, in order. Bots append heartbeats and rewrite
// sections in place; the daily archive run only removes lines, so it yields none.
export function addedLines(before, after) {
  const old = new Set(before.split("\n").map((l) => l.trim()));
  return after.split("\n").map((l) => l.trim()).filter((l) => l && !old.has(l));
}

// Which new line becomes the ping, and its kind. null = stay quiet.
export function fizzSignal(lines) {
  const line = lines.filter((l) => !l.startsWith("#") && !l.startsWith(">")).at(-1);
  if (!line) return null;
  return { kind: /bloquead|esperando/i.test(line) ? "waiting" : "info", text: line };
}

// Polls the status files' mtimes; reads a file only when it changed. The first read of each
// file is its baseline, so starting the server never replays old lines.
export function watchFizz({ dir, add, everyMs = 20_000 }) {
  const seen = new Map(); // file → its last text
  const mtimes = new Map();
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const folders = ["", ...(await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)];
      for (const folder of folders) {
        const file = join(dir, folder, "estado.md");
        const mtime = await stat(file).then((s) => s.mtimeMs, () => null);
        if (mtime == null || mtimes.get(file) === mtime) continue;
        const text = await readFile(file, "utf8").catch(() => null);
        if (text == null) continue;
        const before = seen.get(file);
        mtimes.set(file, mtime);
        seen.set(file, text);
        const signal = before == null ? null : fizzSignal(addedLines(before, text));
        if (signal) add({ node: FIZZ_FOLDERS[folder] ?? FIZZ_FLEET, ...signal });
      }
    } catch {} // the folder is gone or unreadable: try again next tick
    busy = false;
  };
  tick();
  const timer = setInterval(tick, everyMs);
  return () => clearInterval(timer);
}

// What changed between two /api/status reads (null = unreachable) as signals. The first read
// (prev undefined) is the baseline.
export function hermesChanges(prev, next) {
  if (prev === undefined) return [];
  if (!next) return prev ? [{ node: "hermes-dashboard", kind: "waiting", text: "Hermes status unreachable" }] : [];
  if (!prev) return [{ node: "hermes-dashboard", kind: "done", text: "Hermes status reachable again" }];
  const out = [];
  if (prev.gateway_running && !next.gateway_running) {
    out.push({ node: "hermes-gateway", kind: "waiting", text: `Gateway stopped${next.gateway_exit_reason ? `: ${next.gateway_exit_reason}` : ""}` });
  }
  if (!prev.gateway_running && next.gateway_running) out.push({ node: "hermes-gateway", kind: "done", text: "Gateway running again" });
  if (prev.overall === "ok" && next.overall !== "ok") {
    const bad = Object.entries(next.components ?? {}).filter(([, c]) => c?.status !== "ok").map(([name]) => name);
    out.push({ node: "hermes", kind: "waiting", text: `Degraded: ${bad.join(", ") || "unknown"}` });
  }
  if (prev.overall !== "ok" && next.overall === "ok") out.push({ node: "hermes", kind: "done", text: "Healthy again" });
  if (next.version && prev.version !== next.version) out.push({ node: "hermes", kind: "info", text: `Now running ${next.version}` });
  if (!(prev.active_agents > 0) && next.active_agents > 0) {
    out.push({ node: "hermes-gateway", kind: "info", text: `${next.active_agents} agent${next.active_agents === 1 ? "" : "s"} working` });
  }
  return out;
}

export function pollHermes({ url, add, everyMs = 300_000 }) {
  let last; // undefined until the first read
  const tick = async () => {
    let next = null;
    try {
      const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (res.ok) next = await res.json();
    } catch {}
    for (const signal of hermesChanges(last, next)) add(signal);
    last = next;
  };
  tick();
  const timer = setInterval(tick, everyMs);
  return () => clearInterval(timer);
}
