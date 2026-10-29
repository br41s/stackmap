#!/usr/bin/env node
// Claude Code hook → stackmap signal. Register it for Stop and Notification in
// ~/.claude/settings.json: `node /Users/brais/VSCODE/stackmap/scripts/signal-hook.mjs`.
// Reads the hook's JSON on stdin and posts {cwd, kind, text} to the local server, which maps
// the folder to a node. Never blocks the agent: 800 ms timeout, every failure ignored (the
// server not running is the normal case), always exits 0.
import { openSync, readSync, fstatSync, closeSync } from "node:fs";

const ENDPOINT = `http://127.0.0.1:${process.env.STACKMAP_PORT ?? 4317}/api/signal`;

// First non-empty line, capped: whole answers can pass the server's 4 KB body limit.
const firstLine = (text) => (typeof text === "string" ? text.trim().split("\n")[0].slice(0, 500) : "");

// Which hook events become a ping, and what they say. null = stay quiet.
function signalFor(hook) {
  if (hook.hook_event_name === "Notification") return { kind: "waiting", text: firstLine(hook.message) || "Needs you" };
  if (hook.hook_event_name === "Stop" && !hook.stop_hook_active) {
    return { kind: "done", text: firstLine(hook.last_assistant_message) || lastAssistantText(hook.transcript_path) || "Finished a turn" };
  }
  return null;
}

// First line of the last assistant text in the transcript (JSONL). Reads only the tail.
function lastAssistantText(path, tail = 64_000) {
  if (!path) return "";
  try {
    const fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(tail, size));
    readSync(fd, buf, 0, buf.length, size - buf.length);
    closeSync(fd);
    for (const line of buf.toString("utf8").split("\n").reverse()) {
      if (!line.includes('"assistant"')) continue;
      try {
        const entry = JSON.parse(line);
        const parts = entry.type === "assistant" && Array.isArray(entry.message?.content) ? entry.message.content : [];
        const text = parts.filter((p) => p.type === "text" && p.text?.trim()).map((p) => p.text).join(" ");
        if (text) return firstLine(text);
      } catch {} // the first line of the tail is usually cut
    }
  } catch {}
  return "";
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const hook = JSON.parse(raw);
  const signal = signalFor(hook);
  if (!signal) return;
  await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: hook.cwd, ...signal }),
    signal: AbortSignal.timeout(800),
  });
}

main().catch(() => {}).finally(() => process.exit(0));
