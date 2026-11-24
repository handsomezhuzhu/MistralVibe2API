import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";

import { createProxyServer } from "../src/server.mjs";
import { loadConfig, VIBE_SDK_USER_AGENT } from "../src/core.mjs";

/** Mock Mistral upstream: records requests, answers OpenAI-style. */
function startMockUpstream() {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      received.push({ method: req.method, url: req.url, headers: req.headers, body });

      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "mistral-medium-latest" }] }));
        return;
      }

      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = {};
      }

      if (parsed.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
        chunk({ choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] });
        chunk({ choices: [{ index: 0, delta: { content: " there" }, finish_reason: null }] });
        chunk({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
        });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "cmpl-1",
          model: parsed.model,
          choices: [
            { index: 0, finish_reason: "stop", message: { role: "assistant", content: "Hello there" } },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
        })
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, received, port: server.address().port });
    });
  });
}

async function startProxy(upstreamPort, extraEnv = {}) {
  const config = loadConfig({
    MISTRAL_UPSTREAM_BASE: `http://127.0.0.1:${upstreamPort}/v1`,
    MISTRAL_API_KEY: "vibe-secret-key",
    QUIET: "1",
    ...extraEnv,
  });
  const server = createProxyServer(config);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

async function readAll(res) {
  const chunks = [];
  for await (const chunk of res.body) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

test("POST /v1/chat/completions streams through with the Vibe fingerprint", async () => {
  const upstream = await startMockUpstream();
  const proxy = await startProxy(upstream.port);

  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer placeholder-from-agent",
        "user-agent": "claude-cli/2.0.1",
        "x-stainless-lang": "js",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "mistral-medium-latest",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const text = await readAll(res);
    assert.match(text, /Hello/);
    assert.match(text, /there/);
    assert.match(text, /\[DONE\]/);

    // the upstream saw exactly the official Vibe CLI request
    assert.equal(upstream.received.length, 1);
    const seen = upstream.received[0];
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/v1/chat/completions");
    assert.equal(seen.headers.authorization, "Bearer vibe-secret-key");
    assert.equal(seen.headers["user-agent"], VIBE_SDK_USER_AGENT);
    assert.equal(seen.headers["x-stainless-lang"], undefined);
    assert.equal(seen.headers["anthropic-version"], undefined);
    assert.equal(seen.headers["content-type"], "application/json");
    assert.equal(seen.headers.accept, "text/event-stream");
    assert.equal(JSON.parse(seen.body).model, "mistral-medium-latest");
  } finally {
    proxy.server.close();
    upstream.server.close();
  }
});

test("POST /v1/chat/completions passes non-streaming replies through", async () => {
  const upstream = await startMockUpstream();
  const proxy = await startProxy(upstream.port);

  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mistral-small-latest", messages: [] }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.choices[0].message.content, "Hello there");
    assert.equal(upstream.received[0].headers.accept, "application/json");
  } finally {
    proxy.server.close();
    upstream.server.close();
  }
});

test("POST /v1/chat/completions forwards upstream errors verbatim", async () => {
  const failing = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit" } }));
    });
  });
  await new Promise((r) => failing.listen(0, "127.0.0.1", r));
  const proxy = await startProxy(failing.address().port);

  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    assert.equal(res.status, 429);
    const json = await res.json();
    assert.equal(json.error.message, "rate limited");
  } finally {
    proxy.server.close();
    failing.close();
  }
});

test("POST /v1/messages converts streaming Anthropic traffic", async () => {
  const upstream = await startMockUpstream();
  const proxy = await startProxy(upstream.port);

  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "placeholder",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 64,
        stream: true,
        system: "be terse",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const text = await readAll(res);
    assert.match(text, /event: message_start/);
    assert.match(text, /event: content_block_start/);
    assert.match(text, /"text":"Hello"/);
    assert.match(text, /event: message_delta/);
    assert.match(text, /"stop_reason":"end_turn"/);
    assert.match(text, /event: message_stop/);
    assert.match(text, /"input_tokens":9/);

    // the upstream still saw a plain Vibe CLI chat completion
    const seen = upstream.received[0];
    assert.equal(seen.headers["user-agent"], VIBE_SDK_USER_AGENT);
    assert.equal(seen.headers["x-api-key"], undefined);
    const sent = JSON.parse(seen.body);
    assert.equal(sent.model, "claude-sonnet-4-5-20250929");
    assert.equal(sent.stream, true);
    assert.equal(sent.max_tokens, 64);
    assert.equal(sent.messages[0].role, "system");
    assert.equal(sent.messages[1].content, "hi");
  } finally {
    proxy.server.close();
    upstream.server.close();
  }
});

test("POST /v1/messages converts non-streaming Anthropic traffic", async () => {
  const upstream = await startMockUpstream();
  const proxy = await startProxy(upstream.port);

  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.type, "message");
    assert.equal(json.role, "assistant");
    assert.equal(json.content[0].type, "text");
    assert.equal(json.content[0].text, "Hello there");
    assert.equal(json.stop_reason, "end_turn");
    assert.deepEqual(json.usage, { input_tokens: 9, output_tokens: 4 });
  } finally {
    proxy.server.close();
    upstream.server.close();
  }
});

test("POST /v1/messages/count_tokens estimates without calling upstream", async () => {
  const upstream = await startMockUpstream();
  const proxy = await startProxy(upstream.port);

  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "a".repeat(400) }],
      }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.input_tokens, 100);
    assert.equal(upstream.received.length, 0);
  } finally {
    proxy.server.close();
    upstream.server.close();
  }
});

test("GET /v1/models proxies the upstream list", async () => {
  const upstream = await startMockUpstream();
  const proxy = await startProxy(upstream.port);

  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/models`, {
      headers: { authorization: "Bearer anything" },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data[0].id, "mistral-medium-latest");
    assert.equal(upstream.received[0].headers["user-agent"], VIBE_SDK_USER_AGENT);
  } finally {
    proxy.server.close();
    upstream.server.close();
  }
});

test("GET /v1/models falls back to the static catalog when upstream fails", async () => {
  const dead = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(500);
      res.end("nope");
    });
  });
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const proxy = await startProxy(dead.address().port);

  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/models`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(json.data.some((m) => m.id === "mistral-medium-latest"));
    assert.ok(json.data.some((m) => m.id === "codestral-latest"));
  } finally {
    proxy.server.close();
    dead.close();
  }
});

test("requests without any key are rejected with 401", async () => {
  const config = loadConfig({
    MISTRAL_UPSTREAM_BASE: "http://127.0.0.1:1/v1",
    QUIET: "1",
  });
  const server = createProxyServer(config);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.match(json.error.message, /API key/);
  } finally {
    server.close();
  }
});

test("GET /health reports the service", async () => {
  const proxy = await startProxy(1);
  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/health`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.service, "mistral-vibe-2api");
  } finally {
    proxy.server.close();
  }
});

test("MODEL_MAP rewrites the model before it reaches Mistral", async () => {
  const upstream = await startMockUpstream();
  const proxy = await startProxy(upstream.port, {
    MODEL_MAP: '{"fast":"mistral-small-latest"}',
  });

  try {
    await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fast", messages: [] }),
    });
    assert.equal(JSON.parse(upstream.received[0].body).model, "mistral-small-latest");
  } finally {
    proxy.server.close();
    upstream.server.close();
  }
});
