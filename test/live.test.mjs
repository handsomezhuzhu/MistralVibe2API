/**
 * Live regression tests against the real Mistral API.
 *
 * Skipped unless MISTRAL_API_KEY (or VIBE_API_KEY) is set. In CI these run
 * only from the manually dispatched "live" workflow, whose key comes from the
 * repository secret; locally:
 *
 *   MISTRAL_API_KEY=mstrl_... node --test test/live.test.mjs
 *
 * They cover the things mocks cannot: the Vibe-surface model names, the
 * billing endpoints, automatic prompt caching, and the plugin's usage hook
 * reading real data.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeCost,
  extractUsage,
  fetchBilling,
  MODEL_PRICES,
  sanitizeHeaders,
  UPSTREAM_BASE,
  VIBE_SDK_USER_AGENT,
} from "../src/core.mjs";

const API_KEY = process.env.MISTRAL_API_KEY || process.env.VIBE_API_KEY;
const BASE = (process.env.MISTRAL_UPSTREAM_BASE ?? UPSTREAM_BASE).replace(/\/+$/, "");
/** Cheap, fast model on the Vibe surface: keeps the regression cheap to run. */
const MODEL = "deepseek-v4-1-flash-1017";
const live = { skip: !API_KEY };

function headers(body) {
  return sanitizeHeaders(null, { apiKey: API_KEY, body });
}

async function chat(body) {
  const payload = JSON.stringify(body);
  const response = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: headers(payload),
    body: payload,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // an SSE body is not one JSON object; callers use extractUsage for those
  }
  return { status: response.status, json, text };
}

test("models endpoint answers with the key", live, async () => {
  const response = await fetch(`${BASE}/models`, { headers: headers() });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(Array.isArray(data.data) && data.data.length > 0, "model list present");
  const ids = data.data.map((m) => m.id);
  assert.ok(ids.includes(MODEL), `${MODEL} is available to this key`);
});

test("Vibe-surface model names route on the Vibe surface", live, async () => {
  for (const model of ["mistral-vibe-cli-latest", "mistral-vibe-cli-fast"]) {
    const { status, json } = await chat({
      model,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      max_tokens: 16,
    });
    assert.equal(status, 200, `${model} answered 200`);
    assert.ok(json?.choices?.[0]?.message?.content, `${model} returned content`);
  }
});

test("a chat completion reports full usage details", live, async () => {
  const { status, json } = await chat({
    model: MODEL,
    messages: [{ role: "user", content: "Say OK" }],
    max_tokens: 16,
  });
  assert.equal(status, 200);
  const usage = json.usage;
  assert.ok(usage.prompt_tokens > 0, "prompt_tokens reported");
  assert.ok(usage.completion_tokens > 0, "completion_tokens reported");
  // cached_tokens is always present; cache_write_tokens depends on the model
  assert.equal(typeof usage.prompt_tokens_details.cached_tokens, "number");
});

test("tool calling works through the Vibe surface", live, async () => {
  const { status, json } = await chat({
    model: MODEL,
    messages: [{ role: "user", content: "Weather in Paris? Use the tool." }],
    max_tokens: 200,
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather for a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ],
  });
  assert.equal(status, 200);
  assert.equal(json.choices[0].finish_reason, "tool_calls");
  const call = json.choices[0].message.tool_calls?.[0];
  assert.equal(call?.function?.name, "get_weather");
  assert.match(call.function.arguments, /Paris/);
});

test("streaming returns a usage-bearing final chunk", live, async () => {
  const { status, text } = await chat({
    model: MODEL,
    messages: [{ role: "user", content: "Count: 1 2 3" }],
    max_tokens: 32,
    stream: true,
  });
  assert.equal(status, 200);
  const found = extractUsage(text);
  assert.ok(found, "the stream carries a usage object");
  assert.ok(found.usage.prompt_tokens > 0, "usage reports prompt tokens");
});

test("a repeated prompt hits Mistral's automatic cache", live, async () => {
  // A per-run nonce keeps the first request genuinely cold: Mistral caches
  // by prefix, so reusing a filler across runs would pre-warm it.
  const nonce = Math.random().toString(36).slice(2);
  const filler = `Cache prefix ${nonce}: Mistral caches this prefix automatically. `.repeat(
    200
  );
  const body = {
    model: MODEL,
    messages: [{ role: "user", content: `${filler}\nReply with just: CACHED` }],
    max_tokens: 16,
  };
  const cold = await chat(body);
  assert.equal(cold.status, 200);
  const warm = await chat(body);
  assert.equal(warm.status, 200);
  const coldCached = cold.json.usage.prompt_tokens_details.cached_tokens;
  const warmCached = warm.json.usage.prompt_tokens_details.cached_tokens;
  assert.equal(coldCached, 0, "first request is cold");
  assert.ok(warmCached > 0, "second request hits the cache");
  assert.ok(
    warmCached >= warm.json.usage.prompt_tokens * 0.5,
    `cache hit is substantial (${warmCached}/${warm.json.usage.prompt_tokens})`
  );
  // the cost formula must price the cached tokens below the full input rate
  const price = MODEL_PRICES[MODEL];
  assert.ok(price, "the test model has a published price");
  const cost = computeCost(warm.json.usage, price);
  assert.ok(cost > 0, "cost computed");
  assert.ok(
    cost < (warm.json.usage.prompt_tokens * price.input) / 1e6,
    "cached tokens price below the full input rate"
  );
});

test("billing subscription and budget are readable with the key", live, async () => {
  const billing = await fetchBilling(API_KEY, { upstreamBase: BASE });
  assert.ok(billing.subscription, "subscription readable");
  assert.ok(typeof billing.subscription.plan_name === "string");
  const budget = billing.budget;
  assert.ok(budget, "budget readable (key holds see_org_inference_usage)");
  const pools = ["vibe_budget", "api_budget"];
  for (const pool of pools) {
    const entry = budget[pool];
    assert.ok(entry, `${pool} present`);
    assert.ok(typeof entry.usage_percentage === "number");
    assert.ok(entry.initial_budget > 0, `${pool} has an initial budget`);
    assert.ok(entry.currency, `${pool} names a currency`);
  }
  assert.ok(
    budget.vibe_budget.initial_budget !== budget.api_budget.initial_budget,
    "Vibe and API allowances are separate pools"
  );
});

test("the plugin usage hook reports real windows", live, async () => {
  const plugin = (await import("../index.mjs")).default;
  const hooks = await plugin.server({ client: {} }, { upstreamBase: BASE });
  const usage = await hooks.auth.usage(async () => ({ type: "api", key: API_KEY }));
  assert.ok(usage.plan, "plan name reported");
  assert.ok(usage.windows.length >= 1, "at least one budget window");
  const vibe = usage.windows.find((w) => w.name === "Vibe Code");
  assert.ok(vibe, "the Vibe Code window is reported");
  assert.ok(vibe.limit > 0 && vibe.used >= 0, "window carries used/limit");
  assert.ok(vibe.resetsAt, "window carries the reset time");
});

test("the Vibe CLI fingerprint is what we send", live, async () => {
  // A wrong User-Agent would still work today, but the whole point of the
  // proxy is the fingerprint: guard it against accidental drift.
  const headers_ = headers('{"stream":true}');
  assert.equal(headers_.get("user-agent"), VIBE_SDK_USER_AGENT);
  assert.equal(headers_.get("accept"), "text/event-stream");
  assert.equal(headers_.get("authorization"), `Bearer ${API_KEY}`);
});
