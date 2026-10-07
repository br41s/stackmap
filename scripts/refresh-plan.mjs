// node scripts/refresh-plan.mjs [--state-out <path>]
//
// Which slices of the map changed since the last refresh (refresh/state.json), and why:
// commit subjects in their repos, files and folder entries modified since then, Zeabur
// project/service names added or removed. Prints JSON; reads names, dates and commit subjects
// only — never file contents. --state-out writes the state for THIS run (refreshedAt = now)
// to the given path: the refresh PR commits it, so the next run starts from here.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE = process.env.STACKMAP_WORKSPACE ?? dirname(ROOT);
const slices = JSON.parse(readFileSync(join(ROOT, "refresh/slices.json"), "utf8"));
const statePath = join(ROOT, "refresh/state.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const since = new Date(state.refreshedAt ?? 0);
const now = new Date();

const abs = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : resolve(WORKSPACE, p));
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 90_000 }).trim();
const git = (dir, ...args) => run("git", ["-C", dir, ...args]);

function repoChanges(p) {
  const dir = abs(p);
  if (!existsSync(join(dir, ".git"))) return [`${p}: not a git repo here — skipped`];
  try {
    git(dir, "fetch", "-q", "origin");
  } catch {} // no remote (heclient) or offline: the local history still counts
  const ref = ["origin/main", "origin/master", "HEAD"].find((r) => {
    try {
      git(dir, "rev-parse", "--verify", "-q", r);
      return true;
    } catch {
      return false;
    }
  });
  const log = git(dir, "log", `--since=${since.toISOString()}`, "--format=%h %s", "-n", "25", ref);
  return log ? log.split("\n").map((l) => `${p}: ${l}`) : [];
}

const fileChanges = (p) => (existsSync(abs(p)) && statSync(abs(p)).mtime > since ? [`modified ${p}`] : []);

// Direct entries only: added/removed against the last run's list, modified by mtime.
function dirChanges(p, before) {
  const d = abs(p);
  if (!existsSync(d)) return { reasons: [], names: [] };
  const names = readdirSync(d).filter((n) => !n.startsWith(".")).sort();
  const reasons = [];
  if (before) {
    const added = names.filter((n) => !before.includes(n));
    const gone = before.filter((n) => !names.includes(n));
    if (added.length) reasons.push(`${p}: added ${added.join(", ")}`);
    if (gone.length) reasons.push(`${p}: removed ${gone.join(", ")}`);
  }
  const touched = names.filter((n) => (!before || before.includes(n)) && statSync(join(d, n)).mtime > since);
  if (touched.length) reasons.push(`${p}: modified ${touched.slice(0, 10).join(", ")}${touched.length > 10 ? ` and ${touched.length - 10} more` : ""}`);
  return { reasons, names };
}

// "project" and "project/service" names, sorted. null when the CLI is unavailable.
function zeaburNames() {
  const table = (args) => run("zeabur", [...args, "-i=false"]).replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n").map((l) => l.trim().split(/\s+/)).filter((c) => /^[0-9a-f]{24}$/.test(c[0]));
  try {
    const names = [];
    for (const [id, name] of table(["project", "list"])) {
      names.push(name);
      for (const [, service] of table(["service", "list", "--project-id", id])) names.push(`${name}/${service}`);
    }
    return names.sort();
  } catch {
    return null;
  }
}

const plan = { since: state.refreshedAt ?? null, now: now.toISOString(), changed: {}, unchanged: [] };
const next = { refreshedAt: now.toISOString(), dirs: { ...(state.dirs ?? {}) }, zeabur: state.zeabur ?? null };

for (const [name, s] of Object.entries(slices)) {
  if (name.startsWith("_")) continue;
  const reasons = [...(s.repos ?? []).flatMap(repoChanges), ...(s.files ?? []).flatMap(fileChanges)];
  for (const d of s.dirs ?? []) {
    const r = dirChanges(d, state.dirs?.[d]);
    reasons.push(...r.reasons);
    next.dirs[d] = r.names;
  }
  if (s.zeabur) {
    const names = zeaburNames();
    if (names && state.zeabur) {
      const added = names.filter((n) => !state.zeabur.includes(n));
      const gone = state.zeabur.filter((n) => !names.includes(n));
      if (added.length) reasons.push(`zeabur: new ${added.join(", ")}`);
      if (gone.length) reasons.push(`zeabur: gone ${gone.join(", ")}`);
    }
    if (names) next.zeabur = names;
    else reasons.push("zeabur: CLI unavailable — Zeabur not checked");
  }
  const real = reasons.filter((r) => !/skipped|not checked/.test(r));
  if (real.length) plan.changed[name] = reasons;
  else plan.unchanged.push(name);
}

console.log(JSON.stringify(plan, null, 2));
const i = process.argv.indexOf("--state-out");
if (i > 0) writeFileSync(process.argv[i + 1], `${JSON.stringify(next, null, 2)}\n`);
