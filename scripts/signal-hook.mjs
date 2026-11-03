#!/usr/bin/env node
// Claude Code hook → stackmap signal. Register it for Stop and Notification in
// ~/.claude/settings.json: `node /Users/brais/VSCODE/stackmap/scripts/signal-hook.mjs`.
// Reads the hook's JSON on stdin and posts {cwd, kind, text, detail} to the local server, which
// maps the folder to a node: text is the ticker line, detail the message behind it, agent says
// who sent it. Never blocks the agent: 800 ms timeout, every failure ignored (the server not
// running is the normal case), always exits 0.
// Another agent (Gemini, ChatGPT, an adapter…) posts the same body to /api/signal with its own
// id: {node, agent: "gemini" | "chatgpt", kind, text, detail} — see "Agent signals" in the README.
import { openSync, readSync, fstatSync, closeSync } from "node:fs";

const ENDPOINT = `http://127.0.0.1:${process.env.STACKMAP_PORT ?? 4317}/api/signal`;

// First non-empty line for the ticker; the message itself capped for the activity card.
const firstLine = (text) => (typeof text === "string" ? text.trim().split("\n")[0].slice(0, 500) : "");
const clip = (text) => (typeof text === "string" ? text.trim().slice(0, 2000) : "");

// Which hook events become a ping, and what they say. null = stay quiet.
function signalFor(hook) {
  if (hook.hook_event_name === "Notification") return { kind: "waiting", text: firstLine(hook.message) || "Needs you", detail: clip(hook.message) };
  if (hook.hook_event_name === "Stop" && !hook.stop_hook_active) {
    const answer = hook.last_assistant_message || lastAssistantText(hook.transcript_path);
    return { kind: "done", text: firstLine(answer) || "Finished a turn", detail: clip(answer) };
  }
  return null;
}

// The last assistant text in the transcript (JSONL). Reads only the tail.
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
        if (text) return text.trim();
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
    body: JSON.stringify({ cwd: hook.cwd, agent: "claude-code", ...signal }),
    signal: AbortSignal.timeout(800),
  });
}

main().catch(() => {}).finally(() => process.exit(0));
