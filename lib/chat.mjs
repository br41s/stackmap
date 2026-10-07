// Runs one chat turn through the local `claude` CLI and turns its stream-json output into
// { type: "delta" | "tool" | "done" | "error" } events.
//
// The CLI is locked down per call: Read/Grep/Glob only, no MCP servers (so no Buzz posts,
// no Zeabur calls), no user/project settings or CLAUDE.md, no saved session (keeps these
// chats out of ~/.claude/projects and out of ChatMemo's Claude Code import).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// "//" makes a pattern absolute. A bare "**/.env" is relative to cwd and does not cover the
// --add-dir folders (verified: it let a .env through). Read rules also gate Grep and Glob.
const DENY_READS = [
  "//**/.env", "//**/.env.*", "//**/*.pem", "//**/*.key", "//**/*nsec*", "//**/*secret*",
  "//**/credentials*", "//**/.git/**", "//**/node_modules/**",
].map((p) => `Read(${p})`);

// deep=false (the default): no tools at all — one model call per question, ~650 tokens of
// CLI overhead instead of ~4.6k, and no lookup can multiply the context. deep=true: the
// read-only file tools, confined to readDirs.
export function cliArgs({ model, effort, readDirs, system, deep = false }) {
  const tools = deep
    ? ["--tools", "Read,Grep,Glob", ...readDirs.flatMap((d) => ["--add-dir", d]), "--disallowedTools", ...DENY_READS]
    : ["--tools", ""];
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--no-session-persistence",
    "--model", model,
    "--effort", effort,
    "--strict-mcp-config",
    "--setting-sources", "",
    "--permission-mode", "dontAsk",
    ...tools,
    "--system-prompt", system,
  ];
}

// Short, human label for a tool call: the path or pattern it touched.
function toolTarget(name, input = {}) {
  const t = input.file_path ?? input.pattern ?? input.path ?? "";
  return { name, target: String(t).replace(/^\/Users\/[^/]+/, "~") };
}

export function runChat({ prompt, cwd, timeoutMs, onEvent, ...opts }) {
  const child = spawn("claude", cliArgs(opts), { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  let finished = false;
  let wroteText = false;
  const finish = (event) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    onEvent(event);
  };
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    finish({ type: "error", message: `No answer after ${timeoutMs / 1000}s` });
  }, timeoutMs);

  child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
  child.on("error", (err) => finish({ type: "error", message: `Could not start claude: ${err.message}` }));
  child.on("close", (code) => {
    finish({ type: "error", message: `claude exited (${code}) without an answer. ${stderr.trim()}`.trim() });
  });

  createInterface({ input: child.stdout }).on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "stream_event") {
      const ev = msg.event;
      // A new model turn after a tool call: separate it from the text before.
      if (ev?.type === "message_start" && wroteText) onEvent({ type: "delta", text: "\n\n" });
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        wroteText = true;
        onEvent({ type: "delta", text: ev.delta.text });
      }
    } else if (msg.type === "assistant") {
      for (const block of msg.message?.content ?? []) {
        if (block.type === "tool_use") onEvent({ type: "tool", ...toolTarget(block.name, block.input) });
      }
    } else if (msg.type === "result") {
      if (msg.is_error || msg.subtype !== "success") {
        finish({ type: "error", message: msg.result || msg.subtype || "claude reported an error" });
      } else {
        const u = msg.usage ?? {};
        finish({
          type: "done", costUsd: msg.total_cost_usd, ms: msg.duration_ms,
          tokensIn: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          tokensCached: u.cache_read_input_tokens ?? 0,
          tokensOut: u.output_tokens ?? 0,
        });
      }
    }
  });

  child.stdin.end(prompt);
  return () => {
    if (!finished) {
      finished = true;
      clearTimeout(timer);
    }
    child.kill("SIGTERM");
  };
}
