// Starts the real server on a spare port and checks the request guards. Never reaches the
// chat CLI: every request here is refused before that point.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { fileURLToPath } from "node:url";

const PORT = 4399;
let server;

function call(path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: PORT, path, method, headers: { host: `127.0.0.1:${PORT}`, ...headers } }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

before(async () => {
  server = spawn(process.execPath, [fileURLToPath(new URL("../server.mjs", import.meta.url))], { env: { ...process.env, PORT: String(PORT), STACKMAP_FIZZ_DIR: "", STACKMAP_HERMES_STATUS_URL: "", STACKMAP_ACTIVITY_FILE: "", STACKMAP_WEATHER: "off" } });
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (d) => String(d).includes("stackmap on") && resolve());
    server.on("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
});
after(() => server?.kill());

test("serves the page and the merged stack", async () => {
  const page = await call("/");
  assert.equal(page.status, 200);
  assert.match(page.headers["content-security-policy"], /default-src 'self'/);
  const stack = await call("/api/stack");
  const json = JSON.parse(stack.body);
  assert.ok(json.nodes.length > 0 && Array.isArray(json.edges));
});

test("refuses a foreign Host header (DNS rebinding)", async () => {
  assert.equal((await call("/api/stack", { headers: { host: "evil.example" } })).status, 403);
});

test("chat needs this page's Origin and JSON", async () => {
  const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
  const json = { "content-type": "application/json" };
  assert.equal((await call("/api/chat", { method: "POST", headers: json, body })).status, 403);
  assert.equal((await call("/api/chat", { method: "POST", headers: { ...json, origin: "https://evil.example" }, body })).status, 403);
  assert.equal((await call("/api/chat", { method: "POST", headers: { "content-type": "text/plain", origin: `http://127.0.0.1:${PORT}` }, body })).status, 415);
  assert.equal((await call("/api/chat", { method: "POST", headers: { ...json, origin: `http://127.0.0.1:${PORT}` }, body: '{"messages":[]}' })).status, 400);
});

test("signals: local scripts only, JSON only, known nodes only", async () => {
  const json = { "content-type": "application/json" };
  const body = JSON.stringify({ node: "hermes", text: "hi" });
  assert.equal((await call("/api/signal", { method: "POST", headers: { ...json, origin: `http://127.0.0.1:${PORT}` }, body })).status, 403);
  assert.equal((await call("/api/signal", { method: "POST", headers: { ...json, origin: "https://evil.example" }, body })).status, 403);
  assert.equal((await call("/api/signal", { method: "POST", headers: { "content-type": "text/plain" }, body })).status, 415);
  assert.equal((await call("/api/signal", { method: "POST", headers: json, body: '{"node":"nope","text":"hi"}' })).status, 400);
  assert.equal((await call("/api/signal", { method: "POST", headers: json, body: '{"node":"hermes","text":"  "}' })).status, 400);
  assert.equal((await call("/api/signal", { method: "POST", headers: { ...json, host: "evil.example" }, body })).status, 403);
});

test("a signal posted with a folder reaches the live feed as its node", async () => {
  const cwd = fileURLToPath(new URL("../../biglobster/.worktrees/x", import.meta.url));
  const feed = new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: PORT, path: "/api/signals", headers: { host: `127.0.0.1:${PORT}` } }, (res) => {
      let data = "";
      res.on("data", (d) => {
        data += d;
        if (data.includes("event: recent") && !data.includes("event: signal")) post();
        const m = data.match(/event: signal\ndata: (.+)\n/);
        if (m) {
          req.destroy();
          resolve(JSON.parse(m[1]));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
  let posted;
  const post = () => (posted ??= call("/api/signal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, kind: "done", text: "shipped\nthe fix" }) }));
  const signal = await feed;
  assert.equal((await posted).status, 202);
  assert.equal(signal.node, "proj-biglobster");
  assert.equal(signal.kind, "done");
  assert.equal(signal.text, "shipped the fix");
});

test("activity: a node's history carries the full message the feed leaves out", async () => {
  const body = JSON.stringify({ node: "hermes-gateway", kind: "done", text: "Restarted", detail: "Restarted\nafter the **deploy**" });
  assert.equal((await call("/api/signal", { method: "POST", headers: { "content-type": "application/json" }, body })).status, 202);
  const group = JSON.parse((await call("/api/activity?node=hermes")).body);
  const hit = group.signals.find((s) => s.text === "Restarted");
  assert.equal(hit.node, "hermes-gateway"); // a group's card includes what is inside it
  assert.equal(hit.detail, "Restarted\nafter the deploy");
  assert.deepEqual(group.status, []);
  assert.equal((await call("/api/activity?node=nope")).status, 404);
  assert.equal((await call("/api/activity?node=hermes", { headers: { host: "evil.example" } })).status, 403);
});

test("no files outside public/ or the vendor allowlist", async () => {
  assert.notEqual((await call("/../server.mjs")).status, 200);
  assert.notEqual((await call("/%2e%2e/server.mjs")).status, 200);
  assert.equal((await call("/vendor/../../package.json")).status, 404);
  assert.equal((await call("/vendor/cytoscape.min.js")).status, 200);
  assert.equal((await call("/vendor/three/build/three.module.js")).status, 404);
  assert.equal((await call("/%E0%A4%A")).status, 400);
});

test("three.js is served from the vendor allowlist, with the core file its module imports", async () => {
  for (const file of ["three.module.js", "three.core.js"]) {
    const res = await call(`/vendor/${file}`);
    assert.equal(res.status, 200, file);
    assert.match(res.headers["content-type"], /javascript/);
    assert.match(res.headers["content-security-policy"], /default-src 'self'/);
  }
  assert.match((await call("/vendor/three.module.js")).body, /from '\.\/three\.core\.js'/); // the relative import the vendor map must satisfy
  assert.equal((await call("/office.js")).status, 200);
  assert.equal((await call("/office-layout.js")).status, 200);
});

test("signals carry the agent: the one named, else inferred from the node; an unknown one is ignored", async () => {
  const post = (body) => call("/api/signal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ node: "proj-chatmemo", agent: "gemini", kind: "waiting", text: "agent test named" })).status, 202);
  assert.equal((await post({ node: "hermes-gateway", kind: "info", text: "agent test inferred" })).status, 202);
  assert.equal((await post({ node: "proj-chatmemo", agent: "evil\" onclick", kind: "info", text: "agent test unknown" })).status, 202);
  const card = JSON.parse((await call("/api/activity?node=layer-products")).body);
  const hermes = JSON.parse((await call("/api/activity?node=hermes")).body);
  const by = (list, text) => list.signals.find((s) => s.text === text)?.agent;
  assert.equal(by(card, "agent test named"), "gemini");
  assert.equal(by(hermes, "agent test inferred"), "hermes");
  assert.equal(by(card, "agent test unknown"), "claude-code");
});

test("an agent's desk card lists its signals wherever they landed; a task start is a kind of its own", async () => {
  const post = (body) => call("/api/signal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ node: "proj-flywell", agent: "claude-code", kind: "working", text: "desk card test" })).status, 202);
  const desk = JSON.parse((await call("/api/activity?node=claude-code")).body);
  assert.deepEqual(desk.signals.filter((s) => s.text === "desk card test").map((s) => [s.node, s.kind]), [["proj-flywell", "working"]]);
  const plain = JSON.parse((await call("/api/activity?node=cc-hooks")).body);
  assert.equal(plain.signals.some((s) => s.text === "desk card test"), false);
});

test("weather: the page asks the server, which stays quiet when it is switched off", async () => {
  const res = await call("/api/weather");
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { enabled: false, current: null });
  assert.equal((await call("/api/weather", { headers: { host: "evil.example" } })).status, 403);
  assert.equal((await call("/api/weather", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 405);
});
