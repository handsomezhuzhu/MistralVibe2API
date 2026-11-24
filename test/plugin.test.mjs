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
  assert.match(hooks.auth.methods[0].label, /API key/);
});

test("authorize labels a Vibe key and stores its type", async () => {
  const mock = await startAccountMock({ planType: "CHAT" });

  try {
    const hooks = await plugin.server({ client: mockClient }, {
      consoleBase: `http://127.0.0.1:${mock.port}`,
    });
    const method = hooks.auth.methods[0];
    const result = await method.authorize({ apiKey: "vibekey" });
    assert.equal(result.type, "success");
    assert.equal(result.key, "vibekey");
    assert.equal(result.accountId, "vibe · …ekey");
    assert.equal(result.metadata.keyType, "vibe");
    assert.equal(result.metadata.planType, "CHAT");
    assert.equal(result.metadata.planName, "INDIVIDUAL");
    assert.ok(result.metadata.checkedAt);
  } finally {
    mock.server.close();
  }
});

test("authorize labels an API key differently", async () => {
  const mock = await startAccountMock({ planType: "API" });

  try {
    const hooks = await plugin.server({ client: mockClient }, {
      consoleBase: `http://127.0.0.1:${mock.port}`,
    });
    const result = await hooks.auth.methods[0].authorize({ apiKey: "apikey" });
    assert.equal(result.type, "success");
    assert.equal(result.accountId, "api · …ikey");
    assert.equal(result.metadata.keyType, "api");
  } finally {
    mock.server.close();
  }
});

test("authorize refuses a key Mistral rejects", async () => {
  const refused = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(401);
      res.end();
    });
  });
  await new Promise((r) => refused.listen(0, "127.0.0.1", r));

  try {
    const hooks = await plugin.server({ client: mockClient }, {
      consoleBase: `http://127.0.0.1:${refused.address().port}`,
    });
    const result = await hooks.auth.methods[0].authorize({ apiKey: "badkey" });
    assert.equal(result.type, "failed");
    assert.match(result.error, /401/);
  } finally {
    refused.close();
  }
});

test("authorize accepts the key with an unknown type when whoami is unreachable", async () => {
  const hooks = await plugin.server({ client: mockClient }, {
    consoleBase: "http://127.0.0.1:1",
  });
  const result = await hooks.auth.methods[0].authorize({ apiKey: "offlinekey" });
  assert.equal(result.type, "success");
  assert.equal(result.metadata.keyType, "unknown");
  assert.equal(result.accountId, "unknown · …ekey");
});

test("authorize requires a key", async () => {
  const hooks = await plugin.server({ client: mockClient }, {});
  const result = await hooks.auth.methods[0].authorize({ apiKey: "   " });
  assert.equal(result.type, "failed");
});

test("usage hook stays empty without a usageUrl", async () => {
  const hooks = await plugin.server({ client: mockClient }, {});
  const usage = await hooks.auth.usage(async () => ({ type: "api", key: "k" }));
  assert.deepEqual(usage, {});
});

/**
 * A mock serving whoami (console) and the billing endpoints (api), with the
 * whoami plan_type and the budget shape configurable.
 */
function startAccountMock({ planType = "CHAT", budget = true } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers });
      if (req.url === "/api/vibe/whoami") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ plan_type: planType, plan_name: "INDIVIDUAL" }));
        return;
      }
      if (req.url === "/v1/billing/subscription") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ plan_name: "INDIVIDUAL", vibe_payg_enabled: false }));
        return;
      }
      if (req.url === "/v1/billing/budget" && budget) {
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
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, seen, port: server.address().port })
    );
  });
}

test("usage hook reads the billing API and reports both pools", async () => {
  const mock = await startAccountMock({ planType: "CHAT" });

  try {
    const hooks = await plugin.server({ client: mockClient }, {
      upstreamBase: `http://127.0.0.1:${mock.port}/v1`,
      consoleBase: `http://127.0.0.1:${mock.port}`,
    });
    const usage = await hooks.auth.usage(async () => ({ type: "api", key: "k" }));
    assert.equal(usage.plan, "INDIVIDUAL · vibe key");
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
    mock.server.close();
  }
});

test("usage hook reports the plan alone when /budget is forbidden", async () => {
  const mock = await startAccountMock({ planType: "API", budget: false });

  try {
    const hooks = await plugin.server({ client: mockClient }, {
      upstreamBase: `http://127.0.0.1:${mock.port}/v1`,
      consoleBase: `http://127.0.0.1:${mock.port}`,
    });
    const usage = await hooks.auth.usage(async () => ({ type: "api", key: "k" }));
    assert.deepEqual(usage, { plan: "INDIVIDUAL · api key" });
  } finally {
    mock.server.close();
  }
});

test("usage hook stays empty when billing is unreachable", async () => {
  const hooks = await plugin.server({ client: mockClient }, {
    upstreamBase: "http://127.0.0.1:1/v1",
    consoleBase: "http://127.0.0.1:1",
  });
  const usage = await hooks.auth.usage(async () => ({ type: "api", key: "k" }));
  assert.deepEqual(usage, {});
});

test("keyPreference=vibe counts the Vibe pool on a Vibe key and stands an API key by", async () => {
  const mock = await startAccountMock({ planType: "CHAT" });

  try {
    const hooks = await plugin.server({ client: mockClient }, {
      upstreamBase: `http://127.0.0.1:${mock.port}/v1`,
      consoleBase: `http://127.0.0.1:${mock.port}`,
    });
    const vibeKey = await hooks.auth.usage(async () => ({
      type: "api",
      key: "k",
      metadata: { keyType: "vibe" },
    }));
    assert.equal(vibeKey.plan, "INDIVIDUAL · vibe key");
    const [vibe, api] = vibeKey.windows;
    assert.equal(vibe.aside, false, "the Vibe pool counts on a Vibe key");
    assert.equal(api.aside, true, "the API pool only displays");

    const apiKey = await hooks.auth.usage(async () => ({
      type: "api",
      key: "k",
      metadata: { keyType: "api" },
    }));
    const [vibe2, api2] = apiKey.windows;
    // Full standby: nothing counts, so routing keeps to the Vibe key while
    // it has room — a counting 0.9% window would otherwise pull traffic to
    // this key. Both pools still show on the card, and the key is still
    // there for failover once the Vibe pool is spent.
    assert.equal(vibe2.aside, true, "a standby Vibe key shows the Vibe pool aside");
    assert.equal(api2.aside, true, "a standby API key counts nothing");
  } finally {
    mock.server.close();
  }
});

test("keyPreference=api stands a Vibe key by and prefers the API key", async () => {
  const mock = await startAccountMock({ planType: "CHAT" });

  try {
    const hooks = await plugin.server({ client: mockClient }, {
      upstreamBase: `http://127.0.0.1:${mock.port}/v1`,
      consoleBase: `http://127.0.0.1:${mock.port}`,
      keyPreference: "api",
    });
    const vibeKey = await hooks.auth.usage(async () => ({
      type: "api",
      key: "k",
      metadata: { keyType: "vibe" },
    }));
    const [vibe] = vibeKey.windows;
    assert.equal(vibe.aside, true, "under api preference nothing counts for a Vibe key");

    const apiKey = await hooks.auth.usage(async () => ({
      type: "api",
      key: "k",
      metadata: { keyType: "api" },
    }));
    const [, api] = apiKey.windows;
    assert.equal(api.aside, false, "the API pool counts on an API key");
  } finally {
    mock.server.close();
  }
});

test("keyPreference=quota lets every key's own pool count", async () => {
  const mock = await startAccountMock({ planType: "CHAT" });

  try {
    const hooks = await plugin.server({ client: mockClient }, {
      upstreamBase: `http://127.0.0.1:${mock.port}/v1`,
      consoleBase: `http://127.0.0.1:${mock.port}`,
      keyPreference: "quota",
    });
    for (const keyType of ["vibe", "api"]) {
      const usage = await hooks.auth.usage(async () => ({
        type: "api",
        key: "k",
        metadata: { keyType },
      }));
      const [vibe, api] = usage.windows;
      assert.equal(vibe.aside, false, `${keyType} key: the Vibe pool counts`);
      assert.equal(api.aside, false, `${keyType} key: the API pool counts`);
    }
  } finally {
    mock.server.close();
  }
});

test("an unknown key type still reports the Vibe pool as counting", async () => {
  const mock = await startAccountMock({ planType: "CHAT" });

  try {
    const hooks = await plugin.server({ client: mockClient }, {
      upstreamBase: `http://127.0.0.1:${mock.port}/v1`,
      consoleBase: `http://127.0.0.1:1`, // whoami unreachable: type stays unknown
    });
    const usage = await hooks.auth.usage(async () => ({ type: "api", key: "k" }));
    const [vibe] = usage.windows;
    assert.equal(vibe.aside, false, "unknown keys keep the Vibe pool counting");
  } finally {
    mock.server.close();
  }
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
