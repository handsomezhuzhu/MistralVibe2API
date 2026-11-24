/**
 * Full-chain simulation of the plugin against one mock Mistral.
 *
 * Everything the live regression covers against the real API is covered here
 * against a mock: sign-in and key typing, the provider declaration, the model
 * list, a chat completion (plain, streamed, with tools) through the loader's
 * fetch, and the usage read. No key and no network, so CI can run it.
 *
 * The mock decides the key type by the key itself: "vibekey" answers whoami
 * with plan_type CHAT, "apikey" with API — the two product areas Mistral
 * issues, whose usage is billed to different allowance pools.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import plugin from "../index.mjs";
import { VIBE_SDK_USER_AGENT } from "../src/core.mjs";

const mockClient = {
  auth: { set: async () => {}, remove: async () => {} },
  app: { log: async () => {} },
};

/** What magpie saves from an authorize success: the api auth shape. */
function saved(signedIn) {
  return { type: "api", key: signedIn.key, metadata: signedIn.metadata };
}

/** One mock serving the console (whoami) and the API (billing, models, chat). */
function startMockMistral() {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      const key = (req.headers.authorization ?? "").replace(/^Bearer /, "");

      if (req.url === "/api/vibe/whoami") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            plan_type: key === "apikey" ? "API" : "CHAT",
            plan_name: "INDIVIDUAL",
          })
        );
        return;
      }
      if (req.url === "/v1/billing/subscription") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ plan_name: "INDIVIDUAL", vibe_payg_enabled: false }));
        return;
      }
      if (req.url === "/v1/billing/budget") {
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
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ id: "mistral-vibe-cli-latest" }, { id: "deepseek-v4-1-flash-1017" }],
          })
        );
        return;
      }
      if (req.method === "GET" && req.url === "/v1/model-catalog?surface=vibe-code") {
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
              {
                id: "zai-glm-5-3-flash-vibe-free",
                label: "GLM 5.3 Flash (Vibe Free)",
                max_context_length: 262144,
              },
            ],
          })
        );
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        let parsed = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = {};
        }
        const usage = {
          prompt_tokens: 12,
          completion_tokens: 3,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 0 },
        };
        if (parsed.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const chunk = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
          chunk({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
          chunk({ choices: [{ index: 0, delta: { content: "SIM OK" }, finish_reason: null }] });
          chunk({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage,
          });
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "cmpl-sim",
            model: parsed.model,
            choices: [
              {
                index: 0,
                finish_reason: parsed.tools ? "tool_calls" : "stop",
                message: parsed.tools
                  ? {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: "call_sim",
                          type: "function",
                          function: { name: "get_weather", arguments: '{"city":"Paris"}' },
                        },
                      ],
                    }
                  : { role: "assistant", content: "SIM OK" },
              },
            ],
            usage,
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
      resolve({ server, received, port: server.address().port })
    );
  });
}

test("a Vibe key signs in, chats through the loader, and reads its pool", async () => {
  const mock = await startMockMistral();
  const options = {
    upstreamBase: `http://127.0.0.1:${mock.port}/v1`,
    consoleBase: `http://127.0.0.1:${mock.port}`,
  };

  try {
    const hooks = await plugin.server({ client: mockClient }, options);

    // sign-in: the key is typed and labelled
    const signedIn = await hooks.auth.methods[0].authorize({ apiKey: "vibekey" });
    assert.equal(signedIn.type, "success");
    assert.equal(signedIn.accountId, "vibe · …ekey");
    assert.equal(signedIn.metadata.keyType, "vibe");

    // provider declaration
    const cfg = { provider: {} };
    await hooks.config(cfg);
    assert.equal(cfg.provider["mistral-vibe"].name, "Mistral Vibe");
    assert.ok(cfg.provider["mistral-vibe"].models["mistral-vibe-cli-latest"]);

    // model list comes from the Vibe-surface catalog
    const models = await hooks.provider.models(
      { models: {} },
      { auth: { type: "api", key: "vibekey" } }
    );
    assert.equal(models["mistral-medium-latest"].name, "Mistral Medium 3.5");
    assert.equal(models["mistral-medium-latest"].limit.context, 262144);

    // a chat completion through the loader's fetch
    const loaded = await hooks.auth.loader(async () => saved(signedIn));
    assert.equal(loaded.baseURL, options.upstreamBase);
    const response = await loaded.fetch(`${options.upstreamBase}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer old-key",
        "user-agent": "some-harness/9.9",
        "x-stainless-lang": "js",
        origin: "https://example.com",
      },
      body: JSON.stringify({
        model: "mistral-vibe-cli-latest",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.equal(reply.choices[0].message.content, "SIM OK");

    const sent = mock.received.find((r) => r.url === "/v1/chat/completions");
    assert.equal(sent.headers.authorization, "Bearer vibekey");
    assert.equal(sent.headers["user-agent"], VIBE_SDK_USER_AGENT);
    assert.equal(sent.headers["content-type"], "application/json");
    assert.equal(sent.headers["x-stainless-lang"], undefined);
    assert.equal(sent.headers.origin, undefined);
    assert.equal(JSON.parse(sent.body).model, "mistral-vibe-cli-latest");

    // a streamed completion keeps the SSE shape and the accept header
    const streamed = await loaded.fetch(`${options.upstreamBase}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mistral-vibe-cli-latest",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    assert.match(streamed.headers.get("content-type"), /text\/event-stream/);
    const streamedRequest = mock.received[mock.received.length - 1];
    assert.equal(streamedRequest.headers.accept, "text/event-stream");
    const streamText = await streamed.text();
    assert.match(streamText, /SIM OK/);
    assert.match(streamText, /\[DONE\]/);

    // a tool call passes the tools through
    const tooled = await loaded.fetch(`${options.upstreamBase}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mistral-vibe-cli-latest",
        messages: [{ role: "user", content: "weather?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
      }),
    });
    const toolReply = await tooled.json();
    assert.equal(toolReply.choices[0].finish_reason, "tool_calls");
    assert.equal(toolReply.choices[0].message.tool_calls[0].function.name, "get_weather");

    // usage: the Vibe pool counts, the API pool only displays
    const usage = await hooks.auth.usage(async () => saved(signedIn));
    assert.equal(usage.plan, "INDIVIDUAL · vibe key");
    const [vibe, api] = usage.windows;
    assert.equal(vibe.name, "Vibe Code");
    assert.equal(vibe.aside, false);
    assert.equal(api.name, "API");
    assert.equal(api.aside, true);
  } finally {
    mock.server.close();
  }
});

test("an API key on the same account is typed, labelled, and stood by", async () => {
  const mock = await startMockMistral();

  try {
    const hooks = await plugin.server({ client: mockClient }, {
      upstreamBase: `http://127.0.0.1:${mock.port}/v1`,
      consoleBase: `http://127.0.0.1:${mock.port}`,
    });

    const signedIn = await hooks.auth.methods[0].authorize({ apiKey: "apikey" });
    assert.equal(signedIn.accountId, "api · …ikey");
    assert.equal(signedIn.metadata.keyType, "api");

    // it chats just the same
    const loaded = await hooks.auth.loader(async () => saved(signedIn));
    const response = await loaded.fetch(`http://127.0.0.1:${mock.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mistral-vibe-cli-latest", messages: [] }),
    });
    assert.equal(response.status, 200);
    assert.equal(
      mock.received.find((r) => r.url === "/v1/chat/completions").headers.authorization,
      "Bearer apikey"
    );

    // under the default preference it is standby: nothing counts, both pools
    // still show, and it remains available for failover
    const usage = await hooks.auth.usage(async () => saved(signedIn));
    assert.equal(usage.plan, "INDIVIDUAL · api key");
    assert.equal(usage.windows.every((w) => w.aside === true), true);
    assert.equal(usage.windows.length, 2);
  } finally {
    mock.server.close();
  }
});

test("keyPreference=api flips which key type is standby", async () => {
  const mock = await startMockMistral();

  try {
    const hooks = await plugin.server({ client: mockClient }, {
      upstreamBase: `http://127.0.0.1:${mock.port}/v1`,
      consoleBase: `http://127.0.0.1:${mock.port}`,
      keyPreference: "api",
    });
    const vibeKey = await hooks.auth.methods[0].authorize({ apiKey: "vibekey" });
    const usage = await hooks.auth.usage(async () => saved(vibeKey));
    assert.equal(usage.windows.every((w) => w.aside === true), true);

    const apiKey = await hooks.auth.methods[0].authorize({ apiKey: "apikey" });
    const apiUsage = await hooks.auth.usage(async () => saved(apiKey));
    const apiWindow = apiUsage.windows.find((w) => w.name === "API");
    assert.equal(apiWindow.aside, false, "the API pool counts on the preferred type");
  } finally {
    mock.server.close();
  }
});

test("keyPreference=quota lets both key types count their own pool", async () => {
  const mock = await startMockMistral();

  try {
    const hooks = await plugin.server({ client: mockClient }, {
      upstreamBase: `http://127.0.0.1:${mock.port}/v1`,
      consoleBase: `http://127.0.0.1:${mock.port}`,
      keyPreference: "quota",
    });
    for (const key of ["vibekey", "apikey"]) {
      const signedIn = await hooks.auth.methods[0].authorize({ apiKey: key });
      const usage = await hooks.auth.usage(async () => saved(signedIn));
      assert.equal(
        usage.windows.every((w) => w.aside === false),
        true,
        `${key}: both pools count under quota`
      );
    }
  } finally {
    mock.server.close();
  }
});
