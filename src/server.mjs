/**
 * Standalone reverse proxy: OpenAI- and Anthropic-compatible on the client
 * side, Mistral's Vibe endpoint on the upstream side.
 *
 *   node src/server.mjs
 *
 * Environment:
 *   PORT                 listen port                (default 8317)
 *   HOST                 listen host                (default 127.0.0.1)
 *   MISTRAL_API_KEY      your Vibe API key          (or VIBE_API_KEY)
 *   ALLOW_CLIENT_KEY     1 = honor the client's own bearer token
 *   MISTRAL_UPSTREAM_BASE  override the upstream      (default https://api.mistral.ai/v1)
 *   VIBE_USER_AGENT      override the impersonated User-Agent
 *   VIBE_EXTRA_HEADERS   JSON object of extra upstream headers
 *   MODEL_MAP            JSON object of model aliases, e.g. {"devstral":"devstral-small-latest"}
 *   QUIET                1 = silence the request log
 */

import http from "node:http";
import { Readable, Transform } from "node:stream";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  anthropicRequestToOpenAI,
  AnthropicSSEEncoder,
  estimateTokens,
  openAIResponseToAnthropic,
  parseSSE,
  sseEvent,
} from "./anthropic.mjs";
import {
  accumulateUsage,
  emptyUsageRecord,
  extractUsage,
  fetchBilling,
  loadConfig,
  mapModel,
  MODEL_PRICES,
  MODELS,
  resolveApiKey,
  sanitizeHeaders,
} from "./core.mjs";

const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** How much of a streamed reply to keep for the trailing usage object. */
const USAGE_TAIL_BYTES = 32 * 1024;

/** Per-server usage accounting: totals plus a record per model. */
function createStats() {
  const byModel = new Map();
  const total = emptyUsageRecord();
  const stats = {
    since: new Date().toISOString(),
    byModel,
    total,
    /** Fold one completion's usage (usage already carries the wire model). */
    record(model, usage) {
      const key = model ?? "unknown";
      const previous = byModel.get(key) ?? emptyUsageRecord();
      const next = accumulateUsage(previous, usage, MODEL_PRICES[key]);
      byModel.set(key, next);

      const delta = emptyUsageRecord();
      for (const field of Object.keys(delta)) {
        delta[field] = next[field] - previous[field];
      }
      total.requests += delta.requests;
      total.input_tokens += delta.input_tokens;
      total.output_tokens += delta.output_tokens;
      total.cached_input_tokens += delta.cached_input_tokens;
      total.cache_write_tokens += delta.cache_write_tokens;
      total.reasoning_tokens += delta.reasoning_tokens;
      // the total sums the per-model costs; cost_known flags models whose
      // price Mistral does not publish (their cost is not counted)
      total.cost_usd =
        Math.round((total.cost_usd + delta.cost_usd) * 1e9) / 1e9;
      if (!next.cost_known) total.cost_known = false;
    },
    snapshot() {
      const models = {};
      for (const [model, record] of byModel) models[model] = { ...record };
      const totalSnap = { ...total };
      totalSnap.cache_hit_rate =
        total.input_tokens > 0
          ? Math.round((total.cached_input_tokens / total.input_tokens) * 10000) / 10000
          : null;
      return { since: stats.since, total: totalSnap, by_model: models };
    },
  };
  return stats;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendOpenAIError(res, status, message, type = "invalid_request_error") {
  sendJson(res, status, { error: { message, type } });
}

function sendAnthropicError(res, status, type, message) {
  sendJson(res, status, { type: "error", error: { type, message } });
}

/** Stream the upstream response back untouched (SSE stays SSE). */
function pipeUpstream(res, upstream, stats, wireModel) {
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
  });
  if (!upstream.body) {
    res.end();
    return;
  }

  let tail = Buffer.alloc(0);
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      this.push(chunk);
      tail = Buffer.concat([tail, chunk]).slice(-USAGE_TAIL_BYTES);
      cb();
    },
    flush(cb) {
      if (stats) {
        const found = extractUsage(tail);
        if (found) stats.record(wireModel ?? found.model, found.usage);
      }
      cb();
    },
  });

  const stream = Readable.fromWeb(upstream.body).pipe(tap);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
  res.on("close", () => {
    upstream.body.cancel().catch(() => {});
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("request body is not valid JSON");
  }
}

/* ----------------------------- routes ----------------------------- */

async function handleModels(req, res, config) {
  const apiKey = resolveApiKey(req.headers, config);
  if (!apiKey) return sendOpenAIError(res, 401, "missing API key: set MISTRAL_API_KEY or send Authorization");
  try {
    const upstream = await fetch(`${config.upstreamBase}/models`, {
      headers: sanitizeHeaders(null, {
        apiKey,
        userAgent: config.userAgent,
        extraHeaders: config.extraHeaders,
      }),
    });
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
    const data = await upstream.json();
    return sendJson(res, 200, data);
  } catch {
    // Fall back to the static catalog so agents still get a list.
    const now = Math.floor(Date.now() / 1000);
    return sendJson(res, 200, {
      object: "list",
      data: Object.keys(MODELS).map((id) => ({
        id,
        object: "model",
        created: now,
        owned_by: "mistral",
      })),
    });
  }
}

async function handleChatCompletions(req, res, config, stats) {
  const apiKey = resolveApiKey(req.headers, config);
  if (!apiKey) return sendOpenAIError(res, 401, "missing API key: set MISTRAL_API_KEY or send Authorization");

  const body = await readJsonBody(req);
  if (!body.model) return sendOpenAIError(res, 400, "missing model");
  body.model = mapModel(body.model, config.modelMap);

  const payload = JSON.stringify(body);
  const upstream = await fetch(`${config.upstreamBase}/chat/completions`, {
    method: "POST",
    headers: sanitizeHeaders(req.headers, {
      apiKey,
      userAgent: config.userAgent,
      extraHeaders: config.extraHeaders,
      body: payload,
    }),
    body: payload,
  });

  if (!upstream.ok || !body.stream) {
    // Non-streaming (or an error): buffer so the usage can be counted, then
    // send it on verbatim.
    const text = await upstream.text().catch(() => "");
    if (stats && upstream.ok) {
      const found = extractUsage(text);
      if (found) stats.record(body.model, found.usage);
    }
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-cache",
    });
    return res.end(text);
  }

  return pipeUpstream(res, upstream, stats, body.model);
}

async function handleAnthropicMessages(req, res, config, stats) {
  const apiKey = resolveApiKey(req.headers, config);
  if (!apiKey) {
    return sendAnthropicError(res, 401, "authentication_error", "missing API key: set MISTRAL_API_KEY");
  }

  const body = await readJsonBody(req);
  if (!body.model) return sendAnthropicError(res, 400, "invalid_request_error", "missing model");

  const openAI = anthropicRequestToOpenAI(body);
  openAI.model = mapModel(openAI.model, config.modelMap);
  const payload = JSON.stringify(openAI);

  const upstream = await fetch(`${config.upstreamBase}/chat/completions`, {
    method: "POST",
    headers: sanitizeHeaders(req.headers, {
      apiKey,
      userAgent: config.userAgent,
      extraHeaders: config.extraHeaders,
      body: payload,
    }),
    body: payload,
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return sendAnthropicError(
      res,
      upstream.status,
      upstream.status === 401 ? "authentication_error" : "api_error",
      `Mistral answered ${upstream.status}: ${text.slice(0, 2000)}`
    );
  }

  if (!openAI.stream) {
    const json = await upstream.json().catch(() => ({}));
    if (stats && json?.usage) stats.record(openAI.model, json.usage);
    return sendJson(res, 200, openAIResponseToAnthropic(json, body.model));
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const encoder = new AnthropicSSEEncoder(body.model);
  try {
    for await (const event of parseSSE(Readable.fromWeb(upstream.body))) {
      if (event.done) break;
      if (stats && event.data?.usage) stats.record(openAI.model, event.data.usage);
      for (const out of encoder.push(event.data)) res.write(sseEvent(out));
    }
    for (const out of encoder.end()) res.write(sseEvent(out));
    res.end();
  } catch (error) {
    res.write(
      sseEvent({
        type: "error",
        error: { type: "api_error", message: String(error?.message ?? error) },
      })
    );
    res.end();
  }
  res.on("close", () => {
    upstream.body?.cancel().catch(() => {});
  });
}

/** GET /usage: this server's accounting plus the live billing read. */
async function handleUsage(req, res, config, stats) {
  const apiKey = resolveApiKey(req.headers, config);
  const out = { local: stats.snapshot(), billing: null };
  if (apiKey) {
    try {
      out.billing = await fetchBilling(apiKey, config);
    } catch (error) {
      out.billing = { error: String(error?.message ?? error) };
    }
  }
  sendJson(res, 200, out);
}

function handleCountTokens(req, res, body) {
  sendJson(res, 200, { input_tokens: estimateTokens(body) });
}

/* ------------------------------ server ---------------------------- */

export function createProxyServer(config) {
  const stats = createStats();
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const log = (status) => {
      if (config.quiet) return;
      const ms = Date.now() - started;
      process.stdout.write(
        `${new Date().toISOString()} ${req.method} ${path} -> ${status} (${ms}ms)\n`
      );
    };

    try {
      if (req.method === "GET" && (path === "/" || path === "/health")) {
        log(200);
        return sendJson(res, 200, {
          ok: true,
          service: "mistral-vibe-2api",
          upstream: config.upstreamBase,
          routes: [
            "/v1/models",
            "/v1/chat/completions",
            "/v1/messages",
            "/v1/messages/count_tokens",
            "/usage",
          ],
        });
      }
      if (req.method === "GET" && path === "/v1/models") {
        await handleModels(req, res, config);
        return log(res.statusCode);
      }
      if (req.method === "GET" && path === "/usage") {
        await handleUsage(req, res, config, stats);
        return log(res.statusCode);
      }
      if (req.method === "POST" && path === "/v1/chat/completions") {
        await handleChatCompletions(req, res, config, stats);
        return log(res.statusCode);
      }
      if (req.method === "POST" && path === "/v1/messages") {
        await handleAnthropicMessages(req, res, config, stats);
        return log(res.statusCode);
      }
      if (req.method === "POST" && path === "/v1/messages/count_tokens") {
        const body = await readJsonBody(req).catch(() => ({}));
        handleCountTokens(req, res, body);
        return log(res.statusCode);
      }
      log(404);
      return sendOpenAIError(res, 404, `unknown route: ${req.method} ${path}`);
    } catch (error) {
      log(500);
      const message = String(error?.message ?? error);
      if (path === "/v1/messages") {
        return sendAnthropicError(res, 500, "api_error", message);
      }
      return sendOpenAIError(res, 500, message);
    }
  });

  // A client that hangs up mid-stream must not crash the process.
  server.on("request", (_req, res) => {
    res.on("error", () => {});
  });

  return server;
}

const isMain =
  process.argv[1] != null &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const config = loadConfig(process.env);
  const port = Number(process.env.PORT ?? 8317);
  const host = process.env.HOST ?? "127.0.0.1";
  const server = createProxyServer(config);
  server.requestTimeout = 600_000;
  server.listen(port, host, () => {
    process.stdout.write(
      `mistral-vibe-2api listening on http://${host}:${port}\n` +
        `  upstream: ${config.upstreamBase}\n` +
        `  key:     ${config.apiKey ? "configured" : "none (clients must send their own)"}\n` +
        `  UA:      ${config.userAgent}\n`
    );
  });
}
