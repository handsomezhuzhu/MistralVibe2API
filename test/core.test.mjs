import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import {
  isStreamBody,
  loadConfig,
  mapModel,
  MODELS,
  openAIModelsFromUpstream,
  resolveApiKey,
  sanitizeHeaders,
  UPSTREAM_BASE,
  VIBE_SDK_USER_AGENT,
} from "../src/core.mjs";

test("isStreamBody detects stream:true", () => {
  assert.equal(isStreamBody('{"stream":true}'), true);
  assert.equal(isStreamBody('{"stream": true }'), true);
  assert.equal(isStreamBody('{"stream":false}'), false);
  assert.equal(isStreamBody('{"messages":[]}'), false);
  assert.equal(isStreamBody(undefined), false);
});

test("sanitizeHeaders keeps only the official client fingerprint", () => {
  const incoming = {
    host: "127.0.0.1:8317",
    "user-agent": "claude-cli/2.0.1 (external, cli)",
    "x-stainless-lang": "js",
    "x-stainless-package-version": "1.2.3",
    "x-stainless-runtime": "node",
    "x-title": "Claude Code",
    "http-referer": "https://claude.ai/code",
    origin: "https://claude.ai",
    "x-api-key": "sk-ant-placeholder",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    accept: "text/event-stream",
    cookie: "session=abc",
    "content-length": "42",
    "accept-encoding": "gzip, br",
  };

  const headers = sanitizeHeaders(incoming, { apiKey: "vibe-key-123" });

  assert.equal(headers.get("authorization"), "Bearer vibe-key-123");
  assert.equal(headers.get("user-agent"), VIBE_SDK_USER_AGENT);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("accept"), "text/event-stream");

  // nothing that names the harness survives
  for (const name of [
    "host",
    "x-stainless-lang",
    "x-stainless-package-version",
    "x-stainless-runtime",
    "x-title",
    "http-referer",
    "referer",
    "origin",
    "x-api-key",
    "anthropic-version",
    "cookie",
    "content-length",
    "accept-encoding",
  ]) {
    assert.equal(headers.has(name), false, `${name} must be stripped`);
  }
});

test("sanitizeHeaders picks Accept from the body when the client sent none", () => {
  const streamHeaders = sanitizeHeaders({}, { apiKey: "k", body: '{"stream":true}' });
  assert.equal(streamHeaders.get("accept"), "text/event-stream");

  const jsonHeaders = sanitizeHeaders({}, { apiKey: "k", body: '{"stream":false}' });
  assert.equal(jsonHeaders.get("accept"), "application/json");
});

test("sanitizeHeaders applies overrides and extra headers", () => {
  const headers = sanitizeHeaders({}, {
    apiKey: "k",
    userAgent: "custom-agent/1.0",
    extraHeaders: { origin: "https://chat.mistral.ai" },
  });
  assert.equal(headers.get("user-agent"), "custom-agent/1.0");
  assert.equal(headers.get("origin"), "https://chat.mistral.ai");
  assert.equal(headers.get("authorization"), "Bearer k");
});

test("sanitizeHeaders accepts Headers instances (the magpie fetch shape)", () => {
  const incoming = new Headers({
    "content-type": "application/json",
    "user-agent": "some-agent/9.9",
    authorization: "Bearer old-key",
  });
  const headers = sanitizeHeaders(incoming, { apiKey: "new-key" });
  assert.equal(headers.get("authorization"), "Bearer new-key");
  assert.equal(headers.get("user-agent"), VIBE_SDK_USER_AGENT);
  assert.equal(headers.get("content-type"), "application/json");
});

test("resolveApiKey prefers the configured key, optionally the client's", () => {
  const clientHeaders = { authorization: "Bearer client-key" };
  assert.equal(resolveApiKey(clientHeaders, { apiKey: "env-key" }), "env-key");
  assert.equal(
    resolveApiKey(clientHeaders, { apiKey: "env-key", allowClientKey: true }),
    "client-key"
  );
  assert.equal(resolveApiKey(clientHeaders, {}), "client-key");
  assert.equal(resolveApiKey({}, {}), null);
  assert.equal(resolveApiKey({ "x-api-key": "ant-key" }, {}), "ant-key");
  assert.equal(resolveApiKey({ authorization: "Basic zm9v" }, {}), null);
});

test("mapModel applies the alias map", () => {
  assert.equal(mapModel("devstral", { devstral: "devstral-small-latest" }), "devstral-small-latest");
  assert.equal(mapModel("mistral-medium-latest", { devstral: "x" }), "mistral-medium-latest");
  assert.equal(mapModel("mistral-medium-latest", undefined), "mistral-medium-latest");
});

test("openAIModelsFromUpstream merges upstream ids with the static catalog", () => {
  const merged = openAIModelsFromUpstream({
    data: [
      { id: "mistral-medium-latest" },
      { id: "some-new-model" },
      { id: "" },
    ],
  });
  assert.equal(merged["mistral-medium-latest"].name, MODELS["mistral-medium-latest"].name);
  assert.equal(merged["some-new-model"].name, "some-new-model");
  assert.equal(merged["some-new-model"].tool_call, true);
  assert.equal(merged[""], undefined);
});

test("vibeCatalogFromUpstream reads the Vibe-surface catalog", async () => {
  const { vibeCatalogFromUpstream } = await import("../src/core.mjs");
  const merged = vibeCatalogFromUpstream({
    models: [
      {
        id: "mistral-medium-latest",
        label: "Mistral Medium 3.5",
        aliases: ["mistral-medium", "mistral-vibe-cli-latest"],
        max_context_length: 262144,
        parameters: { reasoning: ["none", "high"] },
        capabilities: { completion_chat: true, function_calling: true, vision: true },
      },
      { id: "brand-new", label: "Brand New", max_context_length: 999999 },
    ],
  });
  assert.equal(merged["mistral-medium-latest"].name, "Mistral Medium 3.5");
  assert.equal(merged["mistral-medium-latest"].limit.context, 262144);
  assert.deepEqual(merged["mistral-medium-latest"].aliases, [
    "mistral-medium",
    "mistral-vibe-cli-latest",
  ]);
  assert.equal(merged["brand-new"].limit.context, 999999);
});

test("the catalog ships the Vibe CLI wire names", () => {
  // The harness's LocalModelRoute default; usage is attributed per model.
  assert.ok(MODELS["mistral-vibe-cli-latest"]);
  assert.ok(MODELS["mistral-vibe-cli-with-tools"]);
  assert.ok(MODELS["mistral-vibe-cli-fast"]);
  assert.equal(MODELS["mistral-large-4-0"].limit.context, 1048576);
});

test("loadConfig reads env with sane defaults", () => {
  const config = loadConfig({});
  assert.equal(config.upstreamBase, UPSTREAM_BASE);
  assert.equal(config.userAgent, VIBE_SDK_USER_AGENT);
  assert.equal(config.apiKey, null);
  assert.equal(config.allowClientKey, false);

  const custom = loadConfig({
    MISTRAL_API_KEY: "k",
    VIBE_USER_AGENT: "ua/1.0",
    VIBE_EXTRA_HEADERS: '{"x-tenant":"acme"}',
    ALLOW_CLIENT_KEY: "1",
    MODEL_MAP: '{"fast":"mistral-small-latest"}',
  });
  assert.equal(custom.apiKey, "k");
  assert.equal(custom.userAgent, "ua/1.0");
  assert.deepEqual(custom.extraHeaders, { "x-tenant": "acme" });
  assert.equal(custom.allowClientKey, true);
  assert.deepEqual(custom.modelMap, { fast: "mistral-small-latest" });
});

test("UPSTREAM_BASE points at the official Vibe endpoint", () => {
  assert.equal(UPSTREAM_BASE, "https://api.mistral.ai/v1");
});

/* ------------------------- billing & cost ------------------------- */

test("computeCost follows the Vibe CLI's own formula", async () => {
  const { computeCost } = await import("../src/core.mjs");
  const price = { input: 0.3, cachedInput: 0.007, output: 1.2 }; // DeepSeek V4.1 Flash
  // 1M uncached input, 500k cached input, 100k output
  const cost = computeCost(
    {
      prompt_tokens: 1_500_000,
      completion_tokens: 100_000,
      prompt_tokens_details: { cached_tokens: 500_000 },
    },
    price
  );
  // (1_000_000 * 0.3 + 500_000 * 0.007 + 100_000 * 1.2) / 1e6
  assert.equal(cost, (1_000_000 * 0.3 + 500_000 * 0.007 + 100_000 * 1.2) / 1e6);
});

test("computeCost returns null for models without a published rate", async () => {
  const { computeCost, MODEL_PRICES } = await import("../src/core.mjs");
  assert.equal(computeCost({ prompt_tokens: 10 }, MODEL_PRICES["mistral-medium-latest"]), null);
  assert.equal(MODEL_PRICES["deepseek-v4-1-flash-1017"].input, 0.3);
});

test("accumulateUsage folds usage and tracks cost availability", async () => {
  const { accumulateUsage, emptyUsageRecord } = await import("../src/core.mjs");
  let record = emptyUsageRecord();
  record = accumulateUsage(
    record,
    {
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 5 },
    },
    { input: 0.3, cachedInput: 0.007, output: 1.2 }
  );
  assert.equal(record.requests, 1);
  assert.equal(record.input_tokens, 100);
  assert.equal(record.cached_input_tokens, 60);
  assert.equal(record.cache_write_tokens, 40);
  assert.equal(record.reasoning_tokens, 5);
  assert.equal(record.cost_known, true);
  assert.ok(record.cost_usd > 0);

  record = accumulateUsage(record, { prompt_tokens: 1 }, null);
  assert.equal(record.requests, 2);
  assert.equal(record.cost_known, false);
});

test("extractUsage reads the final chunk of an SSE buffer", async () => {
  const { extractUsage } = await import("../src/core.mjs");
  const sse =
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":4}}}\n\n' +
    "data: [DONE]\n\n";
  const found = extractUsage(Buffer.from(sse));
  assert.equal(found.usage.prompt_tokens, 10);
  assert.equal(found.usage.prompt_tokens_details.cached_tokens, 4);
  assert.equal(extractUsage(Buffer.from("data: [DONE]\n\n")), null);
});

test("extractUsage reads a non-streaming JSON body", async () => {
  const { extractUsage } = await import("../src/core.mjs");
  const found = extractUsage(
    JSON.stringify({ model: "m", usage: { prompt_tokens: 7, completion_tokens: 1 } })
  );
  assert.equal(found.usage.prompt_tokens, 7);
  assert.equal(found.model, "m");
});

test("budgetToWindows maps both pools from the live response shape", async () => {
  const { budgetToWindows } = await import("../src/core.mjs");
  const windows = budgetToWindows({
    vibe_budget: {
      usage_percentage: 13.916714140666667,
      initial_budget: 300.0,
      currency: "USD",
      reset_at: "2026-12-01T00:00:00Z",
      payg_enabled: false,
    },
    api_budget: {
      usage_percentage: 0.9228938266666666,
      initial_budget: 30.0,
      currency: "USD",
      reset_at: "2026-12-01T00:00:00Z",
      payg_enabled: false,
    },
  });
  assert.equal(windows.length, 2);
  const [vibe, api] = windows;
  assert.equal(vibe.name, "Vibe Code");
  assert.equal(vibe.limit, 300);
  assert.equal(vibe.amount, 41.75);
  assert.equal(vibe.unit, "USD");
  assert.equal(vibe.resetsAt, "2026-12-01T00:00:00Z");
  assert.ok(vibe.span > 0);
  assert.equal(api.name, "API");
  assert.equal(api.limit, 30);
  assert.equal(api.amount, 0.28);
});

test("fetchBilling reads both endpoints and tolerates failures", async () => {
  const { fetchBilling } = await import("../src/core.mjs");
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/v1/billing/subscription") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ plan_name: "INDIVIDUAL", vibe_payg_enabled: false }));
        return;
      }
      if (req.url === "/v1/billing/budget") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            vibe_budget: { usage_percentage: 5, initial_budget: 300, currency: "USD" },
          })
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));

  try {
    const billing = await fetchBilling("k", {
      upstreamBase: `http://127.0.0.1:${upstream.address().port}/v1`,
    });
    assert.equal(billing.subscription.plan_name, "INDIVIDUAL");
    assert.equal(billing.budget.vibe_budget.initial_budget, 300);

    // a dead upstream degrades to nulls instead of throwing
    const dead = await fetchBilling("k", { upstreamBase: "http://127.0.0.1:1/v1" });
    assert.deepEqual(dead, { subscription: null, budget: null });
  } finally {
    upstream.close();
  }
});
