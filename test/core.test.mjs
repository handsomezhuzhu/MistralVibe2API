import assert from "node:assert/strict";
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
