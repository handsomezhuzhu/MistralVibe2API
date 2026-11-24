import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";

import plugin from "../index.mjs";
import { VIBE_SDK_USER_AGENT } from "../src/core.mjs";

const mockClient = {
  auth: { set: async () => {}, remove: async () => {} },
  app: { log: async () => {} },
  config: { get: async () => ({}) },
};

test("plugin default export exposes id and server", () => {
  assert.equal(plugin.id, "mistral-vibe");
  assert.equal(typeof plugin.server, "function");
});

test("config hook declares the provider without touching existing ones", async () => {
  const hooks = await plugin.server({ client: mockClient }, {});
  const cfg = { provider: { existing: { name: "Existing" } } };
  await hooks.config(cfg);

  assert.ok(cfg.provider.existing, "existing providers survive");
  const provider = cfg.provider["mistral-vibe"];
  assert.ok(provider);
  assert.equal(provider.name, "Mistral Vibe");
  assert.equal(provider.npm, "@ai-sdk/openai-compatible");
  assert.equal(provider.api, "https://api.mistral.ai/v1");
  assert.ok(provider.models["mistral-medium-latest"]);

  // idempotent: a second run does not overwrite user configuration
  cfg.provider["mistral-vibe"].name = "Customized";
  await hooks.config(cfg);
  assert.equal(cfg.provider["mistral-vibe"].name, "Customized");
});

test("loader returns a fetch that rewrites the request fingerprint", async () => {
  // mock upstream capturing the forwarded request
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));

  try {
    const hooks = await plugin.server({ client: mockClient }, {
      upstreamBase: `http://127.0.0.1:${upstream.address().port}/v1`,
    });
    const loaded = await hooks.auth.loader(async () => ({ type: "api", key: "vibe-key" }));
    assert.equal(loaded.baseURL, `http://127.0.0.1:${upstream.address().port}/v1`);

    const response = await loaded.fetch(
      `http://127.0.0.1:${upstream.address().port}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer vibe-key",
          "user-agent": "some-harness/1.0",
          "x-title": "Some Harness",
        },
        body: JSON.stringify({ model: "mistral-medium-latest", stream: true, messages: [] }),
      }
    );

    assert.equal(response.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers.authorization, "Bearer vibe-key");
    assert.equal(seen[0].headers["user-agent"], VIBE_SDK_USER_AGENT);
    assert.equal(seen[0].headers["x-title"], undefined);
    assert.equal(seen[0].headers.accept, "text/event-stream");
    assert.equal(seen[0].url, "/v1/chat/completions");
    assert.equal(JSON.parse(seen[0].body).model, "mistral-medium-latest");
  } finally {
    upstream.close();
  }
});

test("loader without an api login returns no baseURL", async () => {
  const hooks = await plugin.server({ client: mockClient }, {});
  const loaded = await hooks.auth.loader(async () => ({ type: "oauth" }));
  assert.deepEqual(loaded, {});
});

test("auth declares an api-key method and no oauth flow", async () => {
  const hooks = await plugin.server({ client: mockClient }, {});
  assert.equal(hooks.auth.provider, "mistral-vibe");
  assert.equal(hooks.auth.methods.length, 1);
  assert.equal(hooks.auth.methods[0].type, "api");
  assert.match(hooks.auth.methods[0].label, /Vibe API key/);
});

test("usage hook stays empty without a usageUrl", async () => {
  const hooks = await plugin.server({ client: mockClient }, {});
  const usage = await hooks.auth.usage(async () => ({ type: "api", key: "k" }));
  assert.deepEqual(usage, {});
});

test("usage hook reads the billing API and reports both pools", async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/v1/billing/subscription") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ plan_name: "INDIVIDUAL", vibe_payg_enabled: false }));
        return;
      }
      if (req.url === "/v1/billing/budget") {
        assert.equal(req.headers["user-agent"], VIBE_SDK_USER_AGENT);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            vibe_budget: {
              usage_percentage: 13.92,
              initial_budget: 300,
              currency: "USD",
              reset_at: "2026-12-01T00:00:00Z",
              payg_enabled: false,
            },
            api_budget: {
              usage_percentage: 0.92,
              initial_budget: 30,
              currency: "USD",
              reset_at: "2026-12-01T00:00:00Z",
              payg_enabled: false,
            },
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
    const hooks = await plugin.server({ client: mockClient }, {
      upstreamBase: `http://127.0.0.1:${upstream.address().port}/v1`,
    });
    const usage = await hooks.auth.usage(async () => ({ type: "api", key: "k" }));
    assert.equal(usage.plan, "INDIVIDUAL");
    assert.equal(usage.windows.length, 2);
    const [vibe, api] = usage.windows;
    assert.equal(vibe.name, "Vibe Code");
    assert.equal(vibe.used, 13.92);
    assert.equal(vibe.limit, 300);
    assert.equal(vibe.amount, 41.76);
    assert.equal(vibe.resetsAt, "2026-12-01T00:00:00Z");
    assert.equal(api.name, "API");
    assert.equal(api.limit, 30);
  } finally {
    upstream.close();
  }
});

test("usage hook reports the plan alone when /budget is forbidden", async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/v1/billing/subscription") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ plan_name: "TEAM" }));
        return;
      }
      res.writeHead(403); // member without see_org_inference_usage
      res.end();
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));

  try {
    const hooks = await plugin.server({ client: mockClient }, {
      upstreamBase: `http://127.0.0.1:${upstream.address().port}/v1`,
    });
    const usage = await hooks.auth.usage(async () => ({ type: "api", key: "k" }));
    assert.deepEqual(usage, { plan: "TEAM" });
  } finally {
    upstream.close();
  }
});

test("usage hook stays empty when billing is unreachable", async () => {
  const hooks = await plugin.server({ client: mockClient }, {
    upstreamBase: "http://127.0.0.1:1/v1",
  });
  const usage = await hooks.auth.usage(async () => ({ type: "api", key: "k" }));
  assert.deepEqual(usage, {});
});

test("usage hook reads a configured usage endpoint", async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      assert.equal(req.headers["user-agent"], VIBE_SDK_USER_AGENT);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ plan: "Pro", used: 37, limit: 100 }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));

  try {
    const hooks = await plugin.server({ client: mockClient }, {
      usageUrl: `http://127.0.0.1:${upstream.address().port}/usage`,
    });
    const usage = await hooks.auth.usage(async () => ({ type: "api", key: "k" }));
    assert.equal(usage.plan, "Pro");
    assert.equal(usage.windows[0].used, 37);
    assert.equal(usage.windows[0].limit, 100);
  } finally {
    upstream.close();
  }
});

test("provider.models merges the upstream list, falling back on failure", async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "mistral-medium-latest" }, { id: "brand-new" }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));

  try {
    const hooks = await plugin.server({ client: mockClient }, {
      upstreamBase: `http://127.0.0.1:${upstream.address().port}/v1`,
    });
    const providerModels = await hooks.provider.models(
      { models: { "mistral-medium-latest": { name: "Static" } } },
      { auth: { type: "api", key: "k" } }
    );
    assert.ok(providerModels["mistral-medium-latest"]);
    assert.equal(providerModels["brand-new"].name, "brand-new");

    // no auth: the configured list is returned untouched
    const untouched = await hooks.provider.models({ models: { a: {} } }, {});
    assert.deepEqual(untouched, { a: {} });
  } finally {
    upstream.close();
  }
});

test("provider.models prefers the Vibe-surface catalog", async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/v1/model-catalog?surface=vibe-code") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            models: [
              {
                id: "mistral-medium-latest",
                label: "Mistral Medium 3.5",
                aliases: ["mistral-vibe-cli-latest"],
                max_context_length: 262144,
              },
            ],
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
    const hooks = await plugin.server({ client: mockClient }, {
      upstreamBase: `http://127.0.0.1:${upstream.address().port}/v1`,
    });
    const models = await hooks.provider.models(
      { models: {} },
      { auth: { type: "api", key: "k" } }
    );
    assert.equal(models["mistral-medium-latest"].name, "Mistral Medium 3.5");
    assert.equal(models["mistral-medium-latest"].limit.context, 262144);
  } finally {
    upstream.close();
  }
});

test("provider.models falls back to /v1/models when the catalog 404s", async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "mistral-medium-latest" }, { id: "brand-new" }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));

  try {
    const hooks = await plugin.server({ client: mockClient }, {
      upstreamBase: `http://127.0.0.1:${upstream.address().port}/v1`,
    });
    const models = await hooks.provider.models(
      { models: { "mistral-medium-latest": { name: "Static" } } },
      { auth: { type: "api", key: "k" } }
    );
    assert.ok(models["mistral-medium-latest"]);
    assert.equal(models["brand-new"].name, "brand-new");
  } finally {
    upstream.close();
  }
});

test("provider.models keeps the static list when the upstream fails", async () => {
  const hooks = await plugin.server({ client: mockClient }, {
    upstreamBase: "http://127.0.0.1:1/v1",
  });
  const base = { models: { "mistral-medium-latest": { name: "Static" } } };
  const result = await hooks.provider.models(base, { auth: { type: "api", key: "k" } });
  assert.deepEqual(result, base.models);
});
