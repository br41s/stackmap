import { test } from "node:test";
import assert from "node:assert/strict";
import { requestBody, runOpenRouter } from "../lib/openrouter.mjs";

const stream = (lines) => new ReadableStream({
  start(c) {
    for (const l of lines) c.enqueue(new TextEncoder().encode(l));
    c.close();
  },
});
const fakeFetch = (status, lines, seen = {}) => async (url, init) => {
  seen.url = url;
  seen.init = init;
  return { ok: status === 200, status, body: stream(lines), text: async () => lines.join("") };
};
const run = (fetchImpl) => new Promise((resolve) => {
  const events = [];
  runOpenRouter({
    apiKey: "test-key", model: "openai/gpt-oss-120b", system: "S", prompt: "P", timeoutMs: 5000, fetchImpl,
    onEvent: (ev) => {
      events.push(ev);
      if (ev.type === "done" || ev.type === "error") resolve(events);
    },
  });
});

test("only no-retention providers see the map, reasoning stays low, the answer streams", () => {
  const body = requestBody({ model: "m", system: "S", prompt: "P" });
  assert.deepEqual(body.provider, { data_collection: "deny" });
  assert.equal(body.reasoning.effort, "low");
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages, [{ role: "system", content: "S" }, { role: "user", content: "P" }]);
  assert.ok(body.max_tokens >= 2000, "headroom for reasoning tokens");
});

test("streams text, skips keep-alives, reports usage and real cost", async () => {
  const seen = {};
  const events = await run(fakeFetch(200, [
    ": OPENROUTER PROCESSING\n\n",
    'data: {"choices":[{"delta":{"content":"Zeabur "}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning":"hidden"}}]}\n\ndata: {"choices":[{"delta":{"content":"hosts it."}}]}\n',
    '\ndata: {"choices":[],"usage":{"prompt_tokens":16000,"completion_tokens":300,"prompt_tokens_details":{"cached_tokens":12000},"cost":0.0012}}\n\n',
    "data: [DONE]\n\n",
  ], seen));
  assert.equal(events.filter((e) => e.type === "delta").map((e) => e.text).join(""), "Zeabur hosts it.");
  const done = events.at(-1);
  assert.equal(done.type, "done");
  assert.deepEqual([done.tokensIn, done.tokensCached, done.tokensOut, done.costUsd, done.billed], [16000, 12000, 300, 0.0012, true]);
  assert.equal(seen.init.headers.Authorization, "Bearer test-key");
});

test("an HTTP error or an error chunk ends the answer with a readable message", async () => {
  const http = await run(fakeFetch(402, ['{"error":{"message":"Insufficient credits"}}']));
  assert.equal(http.at(-1).type, "error");
  assert.match(http.at(-1).message, /OpenRouter 402: .*Insufficient credits/);
  const mid = await run(fakeFetch(200, ['data: {"error":{"message":"provider overloaded"}}\n\n']));
  assert.match(mid.at(-1).message, /provider overloaded/);
});
