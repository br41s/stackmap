// Map-only answers through OpenRouter (default openai/gpt-oss-120b): one streamed call, no
// tools, ~$0.001 a question, nothing taken from the Claude subscription. Emits the same
// { type: "delta" | "done" | "error" } events as chat.mjs so the server and page don't care.
//
// Like ChatMemo (lib/server/openrouter.ts): only providers that keep nothing may see the map
// (`provider.data_collection: "deny"`), and reasoning stays low — gpt-oss reasons before it
// answers and those tokens count against max_tokens.

const URL = "https://openrouter.ai/api/v1/chat/completions";

export function requestBody({ model, system, prompt, maxTokens = 4000 }) {
  return {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
    stream: true,
    max_tokens: maxTokens,
    reasoning: { effort: "low", exclude: true },
    provider: { data_collection: "deny" },
    usage: { include: true },
  };
}

// Server-sent events from fetch: "data: {...}" lines, ": comment" keep-alives, "data: [DONE]".
async function* sseData(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith("data: ")) yield line.slice(6);
    }
  }
}

export function runOpenRouter({ apiKey, model, system, prompt, timeoutMs, onEvent, fetchImpl = fetch }) {
  const controller = new AbortController();
  let finished = false;
  const started = Date.now();
  const finish = (ev) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    onEvent(ev);
  };
  const timer = setTimeout(() => {
    controller.abort();
    finish({ type: "error", message: `No answer from ${model} after ${timeoutMs / 1000}s` });
  }, timeoutMs);

  (async () => {
    const res = await fetchImpl(URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "stackmap" },
      body: JSON.stringify(requestBody({ model, system, prompt })),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      return finish({ type: "error", message: `OpenRouter ${res.status}: ${text}` });
    }
    let usage = null;
    for await (const data of sseData(res.body)) {
      if (data === "[DONE]") break;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.error) return finish({ type: "error", message: `OpenRouter: ${chunk.error.message ?? JSON.stringify(chunk.error)}` });
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) onEvent({ type: "delta", text });
      if (chunk.usage) usage = chunk.usage;
    }
    finish({
      type: "done",
      ms: Date.now() - started,
      tokensIn: usage?.prompt_tokens ?? 0,
      tokensCached: usage?.prompt_tokens_details?.cached_tokens ?? 0,
      tokensOut: usage?.completion_tokens ?? 0,
      costUsd: usage?.cost,
      billed: true, // real money on the OpenRouter key, unlike the CLI's notional figure
    });
  })().catch((err) => {
    if (err.name === "AbortError" && finished) return;
    finish({ type: "error", message: `OpenRouter request failed: ${err.message}` });
  });

  return () => {
    if (!finished) {
      finished = true;
      clearTimeout(timer);
    }
    controller.abort();
  };
}
