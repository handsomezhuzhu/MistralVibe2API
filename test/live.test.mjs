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
 *
 * Model availability depends on the key's plan and the caller's region: a
 * paid key reaches the full catalog, a Free-plan key only the *-vibe-free
 * variants, and some hosted models are region-locked. So the chat model is
 * picked at run time from what the key can actually list, and assertions
 * that need a capability the chosen model lacks (a published price, cache
 * reporting) skip with a reason instead of failing.
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
import { splitDeltaContent } from "../src/anthropic.mjs";

const API_KEY = process.env.MISTRAL_API_KEY || process.env.VIBE_API_KEY;
const BASE = (process.env.MISTRAL_UPSTREAM_BASE ?? UPSTREAM_BASE).replace(/\/+$/, "");
/** Models the regression prefers, most widely available first. */
const MODEL_PREFERENCE = [
  "zai-glm-5-3-flash-vibe-free", // Free-plan key: the only GLM Flash it may use
  "zai-glm-5-3-flash",
  "deepseek-v4-1-flash-1017",
  "mistral-large-4-0",
  "mistral-vibe-cli-latest", // the CLI default wire name; the last resort
];
const live = { skip: !API_KEY };

let setupCache = null;

/** One-time discovery: what this key can reach, and which model to chat with. */
async function ensureSetup() {
  if (setupCache) return setupCache;
  const headers_ = headers();
  const ids = new Set();
  // The Vibe-surface catalog is the authoritative list for the surface the
  // proxy forwards to (it is where the *-vibe-free variants live), while
  // /v1/models is the wider API list; a model can appear in either.
  for (const [path, read] of [
    ["/model-catalog?surface=vibe-code", (data) => (data.models ?? []).map((m) => m?.id)],
    ["/models", (data) => (data.data ?? []).map((m) => m?.id)],
  ]) {
    try {
      const response = await fetch(`${BASE}${path}`, { headers: headers_ });
      if (response.ok) {
        const data = await response.json();
        for (const id of read(data)) if (typeof id === "string") ids.add(id);
      }
    } catch {
      // a missing surface is fine: the other list may still answer
    }
  }
  const liveIds = [...ids];
  const model =
    MODEL_PREFERENCE.find((id) => liveIds.includes(id)) ??
    MODEL_PREFERENCE[MODEL_PREFERENCE.length - 1];
  setupCache = {
    liveIds,
    model,
    price: MODEL_PRICES[model] ?? null,
  };
  return setupCache;
}

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

/** Text of a completion whose content may be a string or a chunk array. */
function completionText(message) {
  return splitDeltaContent(message?.content).text;
}

test("models endpoint answers with the key", live, async () => {
  const { liveIds } = await ensureSetup();
  assert.ok(liveIds.length > 0, `model list present (${liveIds.length} ids)`);
  // the CLI's own default wire name must be there: it is what the proxy
  // forwards by default, and it is the one model every key can reach
  assert.ok(
    liveIds.includes("mistral-vibe-cli-latest"),
    `mistral-vibe-cli-latest is available to this key (saw: ${liveIds.slice(0, 12).join(", ")}…)`
  );
});
test("Vibe-surface model names route on the Vibe surface", live, async () => {
  for (const model of ["mistral-vibe-cli-latest", "mistral-vibe-cli-fast"]) {
    const { status, json } = await chat({
      model,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      max_tokens: 16,
    });
    assert.equal(status, 200, `${model} answered 200`);
    assert.ok(completionText(json?.choices?.[0]?.message), `${model} returned content`);
  }
});

test("a chat completion reports full usage details", live, async () => {
  const { model } = await ensureSetup();
  const { status, json } = await chat({
    model,
    messages: [{ role: "user", content: "Say OK" }],
    max_tokens: 16,
  });
  assert.equal(status, 200, `${model} answered 200 (${JSON.stringify(json).slice(0, 300)})`);
  const usage = json.usage;
  assert.ok(usage.prompt_tokens > 0, "prompt_tokens reported");
  assert.ok(usage.completion_tokens > 0, "completion_tokens reported");
  if (usage.prompt_tokens_details) {
    // cached_tokens is present whenever the details object is; some models
    // omit the whole object
    assert.equal(typeof usage.prompt_tokens_details.cached_tokens, "number");
  }
});

test("tool calling works through the Vibe surface", live, async () => {
  const { model } = await ensureSetup();
  const { status, json } = await chat({
    model,
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
  assert.equal(status, 200, `${model} answered 200 (${JSON.stringify(json).slice(0, 300)})`);
  assert.equal(json.choices[0].finish_reason, "tool_calls");
  const call = json.choices[0].message.tool_calls?.[0];
  assert.equal(call?.function?.name, "get_weather");
  assert.match(call.function.arguments, /Paris/);
});

test("streaming returns a usage-bearing final chunk", live, async () => {
  const { model } = await ensureSetup();
  const { status, text } = await chat({
    model,
    messages: [{ role: "user", content: "Count: 1 2 3" }],
    max_tokens: 32,
    stream: true,
  });
  assert.equal(status, 200);
  const found = extractUsage(text);
  assert.ok(found, "the stream carries a usage object");
  assert.ok(found.usage.prompt_tokens > 0, "usage reports prompt tokens");
});

test("a repeated prompt hits Mistral's automatic cache", live, async (t) => {
  const { model, price } = await ensureSetup();
  // A per-run nonce keeps the first request genuinely cold: Mistral caches
  // by prefix, so reusing a filler across runs would pre-warm it.
  const nonce = Math.random().toString(36).slice(2);
  const filler = `Cache prefix ${nonce}: Mistral caches this prefix automatically. `.repeat(
    200
  );
  const body = {
    model,
    messages: [{ role: "user", content: `${filler}\nReply with just: CACHED` }],
    max_tokens: 16,
  };
  const cold = await chat(body);
  assert.equal(
    cold.status,
    200,
    `${model} answered 200 (${JSON.stringify(cold.json).slice(0, 300)})`
  );
  const coldCached = cold.json.usage.prompt_tokens_details?.cached_tokens;
  if (typeof coldCached !== "number") {
    t.skip(`${model} does not report cached_tokens; cache behaviour unverifiable`);
    return;
  }

  // Caching is best-effort server-side: the prefix may need a moment, or the
  // retry may land on a backend without it. Try a few times before giving up.
  let warm = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const reply = await chat(body);
    assert.equal(reply.status, 200);
    if ((reply.json.usage.prompt_tokens_details?.cached_tokens ?? 0) > 0) {
      warm = reply;
      break;
    }
  }
  if (!warm) {
    t.skip(`${model} did not report a cache hit in 3 attempts; Mistral caching is best-effort`);
    return;
  }

  const warmCached = warm.json.usage.prompt_tokens_details.cached_tokens;
  assert.ok(
    warmCached >= warm.json.usage.prompt_tokens * 0.2,
    `cache hit is substantial (${warmCached}/${warm.json.usage.prompt_tokens})`
  );

  if (!price) {
    t.skip(`${model} has no published API rate; cost formula not applicable`);
    return;
  }
  const cost = computeCost(warm.json.usage, price);
  assert.ok(cost > 0, "cost computed");
  assert.ok(
    cost < (warm.json.usage.prompt_tokens * price.input) / 1e6,
    "cached tokens price below the full input rate"
  );
});

test("billing subscription and budget are readable with the key", live, async (t) => {
  const billing = await fetchBilling(API_KEY, { upstreamBase: BASE });
  const raw = JSON.stringify(billing);
  assert.ok(billing.subscription, `subscription readable (${raw})`);
  assert.ok(typeof billing.subscription.plan_name === "string", "plan name present");

  const budget = billing.budget;
  if (!budget) {
    // /budget needs the see_org_inference_usage permission; a member without
    // it legitimately gets 403 here
    t.skip("budget endpoint not readable with this key (no usage permission)");
    return;
  }
  const pools = ["vibe_budget", "api_budget"].filter((key) => budget[key]);
  assert.ok(pools.length >= 1, `at least one allowance pool present (${raw})`);
  for (const pool of pools) {
    assert.equal(
      typeof budget[pool].usage_percentage,
      "number",
      `${pool} reports a usage percentage (${raw})`
    );
  }
  // Both pools on a paid plan are separate allowances; on the Free plan they
  // are equal in size but still separate entries, so only compare when both
  // publish an amount.
  const amounts = pools
    .map((key) => budget[key].initial_budget)
    .filter((value) => typeof value === "number");
  if (amounts.length === 2) {
    assert.ok(amounts[0] > 0 && amounts[1] > 0, `pools carry positive budgets (${raw})`);
  }
});

test("the plugin usage hook reports real windows", live, async (t) => {
  const plugin = (await import("../index.mjs")).default;
  const hooks = await plugin.server({ client: {} }, { upstreamBase: BASE });
  const usage = await hooks.auth.usage(async () => ({ type: "api", key: API_KEY }));
  const raw = JSON.stringify(usage);
  if (usage.windows.length === 0) {
    t.skip(`no budget windows (key lacks usage permission?): ${raw}`);
    return;
  }
  for (const window of usage.windows) {
    assert.ok(window.name, `window named (${raw})`);
    assert.ok(typeof window.used === "number" && window.used >= 0, `window used (${raw})`);
    if (window.limit != null) assert.ok(window.limit > 0, `window limit (${raw})`);
  }
});

test("the Vibe CLI fingerprint is what we send", live, async () => {
  // A wrong User-Agent would still work today, but the whole point of the
  // proxy is the fingerprint: guard it against accidental drift.
  const streamHeaders = headers('{"stream":true}');
  assert.equal(streamHeaders.get("user-agent"), VIBE_SDK_USER_AGENT);
  assert.equal(streamHeaders.get("accept"), "text/event-stream");
  assert.equal(streamHeaders.get("authorization"), `Bearer ${API_KEY}`);
  const jsonHeaders = headers('{"stream":false}');
  assert.equal(jsonHeaders.get("accept"), "application/json");
});
