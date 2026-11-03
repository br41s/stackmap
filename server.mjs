// stackmap server: the map page, /api/stack (merged data/*.json), /api/chat (local claude CLI)
// and agent signals (POST /api/signal in, GET /api/signals out as SSE). Signals also come from
// the Fizz bots' status files and, when STACKMAP_HERMES_STATUS_URL is set, Hermes' /api/status.
// Listens on 127.0.0.1 only. Every request must name this host; chat POSTs must come from
// this page (Origin check) so another site in the browser cannot drive the CLI. Signal POSTs
// come from local scripts (hooks), so they must carry no Origin at all.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, sep, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadStack } from "./lib/stack.mjs";
import { systemPrompt, userPrompt, turnContext } from "./lib/prompt.mjs";
import { runChat } from "./lib/chat.mjs";
import { runOpenRouter } from "./lib/openrouter.mjs";
import { DAYS, FOLDERS, cleanDetail, cleanText, createSignals, nodeForCwd } from "./lib/signals.mjs";
import { fizzStatus, pollHermes, watchFizz } from "./lib/sources.mjs";
import { loadActivity, saveTo } from "./lib/activity.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
// OPENROUTER_API_KEY lives in stackmap/.env (gitignored); never logged, never sent to the page.
try {
  process.loadEnvFile(join(ROOT, ".env"));
} catch {}
const PUBLIC = join(ROOT, "public");
const DATA = join(ROOT, "data");
const PORT = Number(process.env.PORT ?? 4317);
const HOST = "127.0.0.1";
const WORKSPACE = process.env.STACKMAP_WORKSPACE ?? dirname(ROOT);
const READ_DIRS = [WORKSPACE, join(homedir(), "fizz"), join(homedir(), ".buzz")].filter(existsSync);
const MODEL = process.env.STACKMAP_MODEL ?? "sonnet"; // Claude, for Deep (and map only without a key)
// Map-only answers: OpenRouter when a key is set (STACKMAP_MAP_MODEL=claude forces the CLI).
const MAP_MODEL = process.env.STACKMAP_MAP_MODEL ?? "openai/gpt-oss-120b";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const mapViaOpenRouter = () => Boolean(OPENROUTER_KEY) && MAP_MODEL !== "claude";
const modelLabels = () => ({ map: mapViaOpenRouter() ? MAP_MODEL.split("/").pop() : `claude ${MODEL}`, deep: `claude ${MODEL}` });
// Map-only answers read from context already in the prompt: low effort halves output and time.
// Deep mode decides what to look up, so it thinks more. STACKMAP_EFFORT overrides both.
const effortFor = (deep) => process.env.STACKMAP_EFFORT ?? (deep ? "medium" : "low");
const MAX_CHATS = 3;
// Signal sources besides the hook. Fizz: on when the folder exists ("" turns it off).
// Hermes: off unless a status URL is set — the server's only request to the outside.
const FIZZ_DIR = process.env.STACKMAP_FIZZ_DIR ?? join(homedir(), "fizz", "salida");
const HERMES_STATUS_URL = process.env.STACKMAP_HERMES_STATUS_URL ?? "";
// Activity history across restarts (gitignored; "" keeps it in memory only).
const ACTIVITY_FILE = process.env.STACKMAP_ACTIVITY_FILE ?? join(ROOT, ".activity", "activity.jsonl");
const ALLOWED_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));

// Browser libraries, served straight from node_modules (no build step, no CDN).
const VENDOR = {
  "cytoscape.min.js": "cytoscape/dist/cytoscape.min.js",
  "layout-base.js": "layout-base/layout-base.js",
  "cose-base.js": "cose-base/cose-base.js",
  "cytoscape-fcose.js": "cytoscape-fcose/cytoscape-fcose.js",
  "marked.umd.js": "marked/lib/marked.umd.js",
  "purify.min.js": "dompurify/dist/purify.min.js",
  // three 0.187 ships no .min.js: three.module.js imports ./three.core.js, so both go out.
  "three.module.js": "three/build/three.module.js",
  "three.core.js": "three/build/three.core.js",
};
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

let activeChats = 0;
const signals = createSignals(ACTIVITY_FILE
  ? { history: loadActivity(ACTIVITY_FILE, DAYS, { nodes: new Set(loadStack(DATA).nodes.map((n) => n.id)) }), onAdd: saveTo(ACTIVITY_FILE) }
  : {});
function addSignal({ node, agent, kind, text, detail }) {
  const signal = signals.add({ node, agent, kind, text: cleanText(text), detail: cleanDetail(detail || text) });
  console.log(`[signal] ${signal.kind} on ${node} by ${signal.agent}`);
  return signal;
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...SECURITY_HEADERS });
  res.end(body);
}

async function serveFile(res, file) {
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
  } catch {
    send(res, 404, "Not found");
  }
}

function stackPayload() {
  const stack = loadStack(DATA);
  for (const i of stack.issues) if (i.level === "error") console.warn(`[stack] ${i.file}: ${i.message}`);
  return { ...stack, meta: { workspace: WORKSPACE, home: homedir(), models: modelLabels() } };
}

async function readJson(req, limit = 200_000) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error("Body too large");
  }
  return JSON.parse(body);
}

function validMessages(messages) {
  return (
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.length <= 40 &&
    messages.every((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.length <= 8000) &&
    messages.at(-1).role === "user"
  );
}

async function handleChat(req, res) {
  if (req.headers.origin && !ALLOWED_ORIGINS.has(req.headers.origin)) return send(res, 403, "Forbidden origin");
  if (!req.headers.origin) return send(res, 403, "Origin required");
  if (!String(req.headers["content-type"]).startsWith("application/json")) return send(res, 415, "JSON only");
  if (activeChats >= MAX_CHATS) return send(res, 429, "Too many chats running");

  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, "Bad JSON");
  }
  if (!validMessages(body.messages)) return send(res, 400, "Bad messages");

  const stack = stackPayload();
  const focus = stack.nodes.some((n) => n.id === body.focus) ? body.focus : null;
  const asOf = process.env.STACKMAP_AS_OF ?? "2026-10-06";

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", ...SECURITY_HEADERS });
  const emit = (ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);

  activeChats++;
  const started = Date.now();
  const deep = body.deep === true;
  const { ids, details } = turnContext(stack, body.messages, focus);
  const system = systemPrompt(stack, { workspace: WORKSPACE, readDirs: READ_DIRS, asOf, deep });
  const prompt = userPrompt(body.messages, focus, details);
  const backend = !deep && mapViaOpenRouter() ? "openrouter" : "claude";
  const onEvent = (ev) => {
    emit(ev);
    if (ev.type === "done" || ev.type === "error") {
      const tokens = ev.tokensIn ? ` ${ev.tokensIn} in (${ev.tokensCached} cached) / ${ev.tokensOut} out` : "";
      const cost = ev.costUsd ? ` $${ev.costUsd.toFixed(4)}${ev.billed ? " billed" : " notional"}` : "";
      console.log(`[chat] ${ev.type} in ${Date.now() - started}ms${tokens}${cost} · ${deep ? "deep" : "map only"} via ${backend === "openrouter" ? MAP_MODEL : `claude ${MODEL}`} · details for ${ids.length} nodes${ev.message ? ` — ${ev.message}` : ""}`);
      res.end();
    }
  };
  const stop = backend === "openrouter"
    ? runOpenRouter({ apiKey: OPENROUTER_KEY, model: MAP_MODEL, system, prompt, timeoutMs: 120_000, onEvent })
    : runChat({ prompt, system, deep, model: MODEL, effort: effortFor(deep), readDirs: READ_DIRS, cwd: ROOT, timeoutMs: 240_000, onEvent });
  res.on("close", () => {
    activeChats--;
    stop();
  });
}

// A ping from a local agent: {node} or {cwd} (mapped through FOLDERS), a kind, one line of text
// and optionally the message behind it (detail) and who sent it (agent; inferred from the node).
// No Origin allowed: a browser always sends one on a cross-site POST, a hook's fetch never does.
async function handleSignal(req, res) {
  if (req.headers.origin) return send(res, 403, "Signals come from local scripts, not pages");
  if (!String(req.headers["content-type"]).startsWith("application/json")) return send(res, 415, "JSON only");
  let body;
  try {
    body = await readJson(req, 16_000);
  } catch {
    return send(res, 400, "Bad JSON");
  }
  const ids = new Set(loadStack(DATA).nodes.map((n) => n.id));
  const node = ids.has(body?.node) ? body.node : nodeForCwd(body?.cwd, { workspace: WORKSPACE, home: homedir() });
  const text = cleanText(body?.text);
  if (!node || !ids.has(node)) return send(res, 400, "Unknown node");
  if (!text) return send(res, 400, "Text required");
  const signal = addSignal({ node, agent: body.agent, kind: body.kind, text, detail: body.detail });
  return send(res, 202, JSON.stringify({ id: signal.id, node }), "application/json");
}

// The page's live feed: the recent signals once, then each new one. A comment every 25 s keeps
// idle connections open through anything that times them out.
function streamSignals(req, res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", ...SECURITY_HEADERS });
  res.write(`event: recent\ndata: ${JSON.stringify(signals.recent())}\n\n`);
  const unsubscribe = signals.subscribe((s) => res.write(`event: signal\ndata: ${JSON.stringify(s)}\n\n`));
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
  res.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
}

// A node's activity card: the signals of the node and everything inside it (newest first, with
// their details) and, for a Fizz bot, its status files.
async function activityFor(res, id) {
  const { nodes } = loadStack(DATA);
  if (!nodes.some((n) => n.id === id)) return send(res, 404, "Unknown node");
  const children = new Map();
  for (const n of nodes) if (n.parent) children.set(n.parent, [...(children.get(n.parent) ?? []), n.id]);
  const ids = [];
  for (const stack = [id]; stack.length; ) {
    const cur = stack.pop();
    ids.push(cur);
    stack.push(...(children.get(cur) ?? []));
  }
  const status = await fizzStatus(FIZZ_DIR && existsSync(FIZZ_DIR) ? FIZZ_DIR : "", id);
  return send(res, 200, JSON.stringify({ node: id, days: DAYS, signals: signals.forNodes(ids), status }), "application/json");
}

const server = createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error("[server]", err);
    if (!res.headersSent) send(res, 500, "Server error");
    else res.end();
  });
});

async function route(req, res) {
  if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) return send(res, 403, "Forbidden host");
  const url = new URL(req.url, `http://${req.headers.host}`);
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, "Bad path");
  }

  if (req.method === "POST" && path === "/api/chat") return handleChat(req, res);
  if (req.method === "POST" && path === "/api/signal") return handleSignal(req, res);
  if (req.method !== "GET") return send(res, 405, "Method not allowed");
  if (path === "/api/stack") return send(res, 200, JSON.stringify(stackPayload()), "application/json");
  if (path === "/api/signals") return streamSignals(req, res);
  if (path === "/api/activity") return activityFor(res, url.searchParams.get("node") ?? "");
  if (path.startsWith("/vendor/")) {
    const rel = VENDOR[path.slice("/vendor/".length)];
    return rel ? serveFile(res, join(ROOT, "node_modules", rel)) : send(res, 404, "Not found");
  }
  const file = normalize(join(PUBLIC, path === "/" ? "index.html" : path));
  if (!file.startsWith(PUBLIC + sep)) return send(res, 403, "Forbidden");
  return serveFile(res, file);
}

server.listen(PORT, HOST, () => {
  const { nodes, edges, issues } = loadStack(DATA);
  console.log(`stackmap on http://${HOST}:${PORT} — ${nodes.length} nodes, ${edges.length} edges, ${issues.length} issues`);
  const ids = new Set(nodes.map((n) => n.id));
  for (const [folder, id] of Object.entries(FOLDERS)) if (!ids.has(id)) console.warn(`[signal] ${folder} points at ${id}, which is not on the map`);
  const sources = ["hook POSTs"];
  if (FIZZ_DIR && existsSync(FIZZ_DIR)) {
    watchFizz({ dir: FIZZ_DIR, add: (s) => addSignal({ agent: "buzz", ...s }) });
    sources.push(`Fizz status files in ${FIZZ_DIR}`);
  }
  if (HERMES_STATUS_URL) {
    pollHermes({ url: HERMES_STATUS_URL, add: (s) => addSignal({ agent: "hermes", ...s }) });
    sources.push(`Hermes ${HERMES_STATUS_URL} every 5 min`);
  }
  console.log(`signals: ${sources.join("; ")}`);
  const map = mapViaOpenRouter() ? `${MAP_MODEL} via OpenRouter` : `claude ${MODEL}, no tools, effort ${effortFor(false)}${OPENROUTER_KEY ? "" : " (no OPENROUTER_API_KEY in .env)"}`;
  console.log(`chat: map only → ${map}; deep → claude ${MODEL}, Read/Grep/Glob in ${READ_DIRS.join(", ")}, effort ${effortFor(true)}`);
});
