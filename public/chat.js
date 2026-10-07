// Floating chat. Sends the conversation to /api/chat and renders the streamed answer.
// [[node-id]] in answers becomes a link that focuses the node on the map.

const $ = (sel) => document.querySelector(sel);
const STORE_KEY = "stackmap.chat";
const SUGGESTIONS = [
  "What runs on the Frankfurt server, and what breaks if it goes down?",
  "How does Hermes publish a blog post, end to end?",
  "Which projects depend on Zeabur, and which don't?",
  "What can Claude Code touch in Buzz?",
];

let opts;
const DEEP_KEY = "stackmap.deep";
let deep = false;
try {
  deep = localStorage.getItem(DEEP_KEY) === "1";
} catch {}

// "6.2s · 14.1k tokens in, 12.8k cached · 420 out"
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
function meta(ev, started, mode) {
  const secs = `${((performance.now() - started) / 1000).toFixed(1)}s`;
  if (!ev.tokensIn) return `${secs} · ${mode}`;
  return `${secs} · ${mode} · ${k(ev.tokensIn)} tokens in, ${k(ev.tokensCached)} cached · ${k(ev.tokensOut)} out`;
}

function paintDeep() {
  const btn = $("#chat-deep");
  btn.setAttribute("aria-pressed", String(deep));
  btn.textContent = deep ? "Deep: on" : "Deep: off";
}
let messages = [];
let controller = null;

function load() {
  try {
    messages = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "[]");
  } catch {
    messages = [];
  }
}
function save() {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(messages));
  } catch {}
}

DOMPurify.addHook("afterSanitizeAttributes", (el) => {
  if (el.tagName === "A" && !el.getAttribute("href")?.startsWith("#node/")) {
    el.setAttribute("target", "_blank");
    el.setAttribute("rel", "noopener noreferrer");
  }
});

function renderMarkdown(text) {
  const linked = text.replace(/\[\[([a-z0-9][a-z0-9._-]*)\]\]/gi, (m, id) => {
    const label = opts.labelOf(id);
    return label ? `[${label.replace(/[[\]]/g, "")}](#node/${id})` : `\`${id}\``;
  });
  const html = DOMPurify.sanitize(marked.parse(linked, { gfm: true, breaks: false }), { FORBID_ATTR: ["style"] });
  const div = document.createElement("div");
  div.className = "body";
  div.innerHTML = html;
  for (const a of div.querySelectorAll('a[href^="#node/"]')) a.classList.add("node-link");
  return div;
}

function bubble(m) {
  const el = document.createElement("div");
  el.className = `msg ${m.role}${m.error ? " error" : ""}`;
  if (m.role === "user") {
    el.textContent = m.content;
    return el;
  }
  if (m.tools?.length) {
    const act = document.createElement("div");
    act.className = "activity";
    for (const t of m.tools) {
      const row = document.createElement("div");
      row.textContent = `${t.name} ${t.target}`;
      act.append(row);
    }
    el.append(act);
  }
  if (m.content) el.append(renderMarkdown(m.content));
  else if (m.pending) {
    const typing = document.createElement("span");
    typing.className = "typing";
    typing.innerHTML = "<i></i><i></i><i></i>";
    el.append(typing);
  }
  if (m.meta) {
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = m.meta;
    el.append(meta);
  }
  return el;
}

function renderLog() {
  const log = $("#chat-log");
  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "chat-empty";
    empty.textContent = "Ask anything about the stack. Answers come from the map — turn on Deep when a question needs the real repo files (read-only, several times the tokens).";
    const chips = document.createElement("div");
    chips.className = "chips";
    for (const s of SUGGESTIONS) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = s;
      b.addEventListener("click", () => ask(s));
      chips.append(b);
    }
    empty.append(chips);
    log.replaceChildren(empty);
    return;
  }
  log.replaceChildren(...messages.map(bubble));
  log.scrollTop = log.scrollHeight;
}

function renderFocus() {
  const box = $("#chat-focus");
  const id = opts.getFocus();
  const label = id && opts.labelOf(id);
  if (!label) {
    box.hidden = true;
    return;
  }
  const clear = document.createElement("button");
  clear.textContent = "✕";
  clear.title = "Don't send the selection";
  clear.addEventListener("click", () => {
    opts.clearFocus();
    renderFocus();
  });
  box.replaceChildren(`About: ${label}`, clear);
  box.hidden = false;
}

function setBusy(busy) {
  const btn = $("#chat-send");
  btn.textContent = busy ? "Stop" : "Send";
  btn.classList.toggle("stop", busy);
}

// Minimal SSE reader over fetch (EventSource cannot POST).
async function* sse(response) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (data) yield JSON.parse(data.slice(6));
    }
  }
}

async function ask(text) {
  const question = text.trim();
  if (!question || controller) return;
  messages.push({ role: "user", content: question });
  const answer = { role: "assistant", content: "", tools: [], pending: true };
  messages.push(answer);
  renderLog();
  setBusy(true);
  controller = new AbortController();
  const started = performance.now();
  const mode = deep ? "deep" : "map only";
  let frame = 0;
  const repaint = () => {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; renderLog(); });
  };
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: messages.filter((m) => m !== answer && !m.error).map(({ role, content }) => ({ role, content })),
        focus: opts.getFocus(),
        deep,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    for await (const ev of sse(res)) {
      if (ev.type === "delta") answer.content += ev.text;
      else if (ev.type === "tool") answer.tools.push(ev);
      else if (ev.type === "done") answer.meta = meta(ev, started, mode);
      else if (ev.type === "error") throw new Error(ev.message);
      repaint();
    }
  } catch (err) {
    if (err.name === "AbortError") answer.meta = "stopped";
    else {
      answer.error = true;
      answer.content = (answer.content ? `${answer.content}\n\n` : "") + `**Error:** ${err.message}`;
    }
  } finally {
    answer.pending = false;
    if (!answer.content && !answer.error) answer.content = "_(no answer)_";
    controller = null;
    setBusy(false);
    save();
    renderLog();
  }
}

export function openChat({ prefill } = {}) {
  $("#chat").hidden = false;
  renderFocus();
  renderLog();
  const input = $("#chat-input");
  if (prefill) input.value = prefill;
  input.focus();
}

function closeChat() {
  $("#chat").hidden = true;
  $("#chat-fab").focus();
}

export function initChat(options) {
  opts = options;
  load();
  $("#chat-model").textContent = `claude · ${opts.model}`;
  paintDeep();
  $("#chat-deep").addEventListener("click", () => {
    deep = !deep;
    try {
      localStorage.setItem(DEEP_KEY, deep ? "1" : "0");
    } catch {}
    paintDeep();
  });
  $("#chat-fab").addEventListener("click", () => ($("#chat").hidden ? openChat() : closeChat()));
  $("#chat-close").addEventListener("click", closeChat);
  $("#chat-new").addEventListener("click", () => {
    controller?.abort();
    messages = [];
    save();
    renderLog();
  });
  $("#chat-log").addEventListener("click", (ev) => {
    const a = ev.target.closest('a[href^="#node/"]');
    if (!a) return;
    ev.preventDefault();
    opts.onNodeLink(a.getAttribute("href").slice("#node/".length));
  });
  const form = $("#chat-form");
  const input = $("#chat-input");
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (controller) return controller.abort();
    const text = input.value;
    input.value = "";
    ask(text);
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      form.requestSubmit();
    }
    if (ev.key === "Escape") closeChat();
  });
  // Keep the "About:" chip in sync with the map selection while the chat is open.
  document.addEventListener("click", () => !$("#chat").hidden && renderFocus());
}
