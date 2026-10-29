import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIZZ_FLEET, FIZZ_FOLDERS, HERMES_NODES, addedLines, fizzSignal, hermesChanges, watchFizz } from "../lib/sources.mjs";
import { loadStack } from "../lib/stack.mjs";

test("every node the sources ping is on the map", () => {
  const ids = new Set(loadStack(fileURLToPath(new URL("../data", import.meta.url))).nodes.map((n) => n.id));
  for (const id of [...Object.values(FIZZ_FOLDERS), FIZZ_FLEET, ...HERMES_NODES]) assert.ok(ids.has(id), `${id} missing from data/`);
});

test("only lines a file did not have count; the archive run (removals) yields none", () => {
  const before = "# Estado\n- a\n- b\nLatido 21:10: nada toca\n";
  assert.deepEqual(addedLines(before, `${before}Latido 22:10: normas leídas\n`), ["Latido 22:10: normas leídas"]);
  assert.deepEqual(addedLines(before, "# Estado\n- b\n- a (resuelto)\n"), ["- a (resuelto)"]);
  assert.deepEqual(addedLines(before, "# Estado\nLatido 21:10: nada toca\n"), []);
});

test("the last new line becomes the ping; headings and quotes never do", () => {
  assert.deepEqual(fizzSignal(["- x", "Latido 22:10: nada toca"]), { kind: "info", text: "Latido 22:10: nada toca" });
  assert.equal(fizzSignal(["## Bloqueado", "> nota"]), null);
  assert.equal(fizzSignal(["- X ronda bloqueada (403)"]).kind, "waiting");
  assert.equal(fizzSignal([]), null);
});

test("the watcher pings appended lines per bot and stays quiet on start and on the archive run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stackmap-fizz-"));
  await mkdir(join(dir, "seo"));
  await mkdir(join(dir, "growth"));
  await writeFile(join(dir, "seo", "estado.md"), "# Estado SEODesk\n- old line\n");
  await writeFile(join(dir, "growth", "estado.md"), "- g1\n- g2\n");
  const got = [];
  const stop = watchFizz({ dir, add: (s) => got.push(s), everyMs: 25 });
  const settle = () => new Promise((r) => setTimeout(r, 120));
  await settle();
  assert.deepEqual(got, []);
  await writeFile(join(dir, "seo", "estado.md"), "# Estado SEODesk\n- old line\nLatido 09:10: PR #660 abierto\n");
  await writeFile(join(dir, "growth", "estado.md"), "- g2\n");
  await settle();
  stop();
  assert.deepEqual(got, [{ node: "fizz-bot-seodesk", kind: "info", text: "Latido 09:10: PR #660 abierto" }]);
});

test("Hermes: the first read is a baseline; changes become signals", () => {
  const ok = { version: "0.9.1", gateway_running: true, overall: "ok", active_agents: 0, components: { storage: { status: "ok" } } };
  assert.deepEqual(hermesChanges(undefined, ok), []);
  assert.deepEqual(hermesChanges(ok, ok), []);
  const texts = (prev, next) => hermesChanges(prev, next).map((s) => `${s.node} ${s.kind} ${s.text}`);
  assert.deepEqual(texts(ok, { ...ok, gateway_running: false, gateway_exit_reason: "oom" }), ["hermes-gateway waiting Gateway stopped: oom"]);
  assert.deepEqual(texts({ ...ok, gateway_running: false }, ok), ["hermes-gateway done Gateway running again"]);
  assert.deepEqual(texts(ok, { ...ok, overall: "degraded", components: { storage: { status: "degraded" }, cron: { status: "ok" } } }), ["hermes waiting Degraded: storage"]);
  assert.deepEqual(texts({ ...ok, overall: "degraded" }, ok), ["hermes done Healthy again"]);
  assert.deepEqual(texts(ok, { ...ok, version: "0.9.2" }), ["hermes info Now running 0.9.2"]);
  assert.deepEqual(texts(ok, { ...ok, active_agents: 2 }), ["hermes-gateway info 2 agents working"]);
  assert.deepEqual(texts({ ...ok, active_agents: 1 }, { ...ok, active_agents: 3 }), []);
  assert.deepEqual(texts(ok, null), ["hermes-dashboard waiting Hermes status unreachable"]);
  assert.deepEqual(texts(null, null), []);
  assert.deepEqual(texts(null, ok), ["hermes-dashboard done Hermes status reachable again"]);
});
