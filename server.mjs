// stackmap server: the map page, /api/stack (merged data/*.json) and /api/chat (local claude CLI).
// Listens on 127.0.0.1 only. Every request must name this host; chat POSTs must come from
// this page (Origin check) so another site in the browser cannot drive the CLI.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, sep, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadStack } from "./lib/stack.mjs";
import { systemPrompt, userPrompt, turnContext } from "./lib/prompt.mjs";
import { runChat } from "./lib/chat.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, "public");
const DATA = join(ROOT, "data");
const PORT = Number(process.env.PORT ?? 4317);
const HOST = "127.0.0.1";
const WORKSPACE = process.env.STACKMAP_WORKSPACE ?? dirname(ROOT);
const READ_DIRS = [WORKSPACE, join(homedir(), "fizz"), join(homedir(), ".buzz")].filter(existsSync);
const MODEL = process.env.STACKMAP_MODEL ?? "sonnet";
// Map-only answers read from context already in the prompt: low effort halves output and time.
// Deep mode decides what to look up, so it thinks more. STACKMAP_EFFORT overrides both.
const effortFor = (deep) => process.env.STACKMAP_EFFORT ?? (deep ? "medium" : "low");
const MAX_CHATS = 3;
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
};
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

let activeChats = 0;

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
  return { ...stack, meta: { workspace: WORKSPACE, home: homedir(), model: MODEL } };
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
  const stop = runChat({
    prompt: userPrompt(body.messages, focus, details),
    system: systemPrompt(stack, { workspace: WORKSPACE, readDirs: READ_DIRS, asOf, deep }),
    deep,
    model: MODEL,
    effort: effortFor(deep),
    readDirs: READ_DIRS,
    cwd: ROOT,
    timeoutMs: 240_000,
    onEvent: (ev) => {
      emit(ev);
      if (ev.type === "done" || ev.type === "error") {
        const tokens = ev.tokensIn ? ` ${ev.tokensIn} in (${ev.tokensCached} cached) / ${ev.tokensOut} out` : "";
        console.log(`[chat] ${ev.type} in ${Date.now() - started}ms${tokens}${ev.costUsd ? ` $${ev.costUsd.toFixed(4)}` : ""} · ${deep ? "deep" : "map only"} · details for ${ids.length} nodes${ev.message ? ` — ${ev.message}` : ""}`);
        res.end();
      }
    },
  });
  res.on("close", () => {
    activeChats--;
    stop();
  });
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
  if (req.method !== "GET") return send(res, 405, "Method not allowed");
  if (path === "/api/stack") return send(res, 200, JSON.stringify(stackPayload()), "application/json");
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
  console.log(`chat: claude -p --model ${MODEL}; map only (no tools, effort ${effortFor(false)}) or deep (Read/Grep/Glob in ${READ_DIRS.join(", ")}, effort ${effortFor(true)})`);
});
