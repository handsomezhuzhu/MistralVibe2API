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
import { Readable } from "node:stream";
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
  loadConfig,
  mapModel,
  MODELS,
  resolveApiKey,
  sanitizeHeaders,
} from "./core.mjs";

const MAX_BODY_BYTES = 64 * 1024 * 1024;

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
function pipeUpstream(res, upstream) {
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
  });
  if (!upstream.body) {
    res.end();
    return;
  }
  const stream = Readable.fromWeb(upstream.body);
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

async function handleChatCompletions(req, res, config) {
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
  return pipeUpstream(res, upstream);
}

async function handleAnthropicMessages(req, res, config) {
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

function handleCountTokens(req, res, body) {
  sendJson(res, 200, { input_tokens: estimateTokens(body) });
}

/* ------------------------------ server ---------------------------- */

export function createProxyServer(config) {
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
          routes: ["/v1/models", "/v1/chat/completions", "/v1/messages", "/v1/messages/count_tokens"],
        });
      }
      if (req.method === "GET" && path === "/v1/models") {
        await handleModels(req, res, config);
        return log(res.statusCode);
      }
      if (req.method === "POST" && path === "/v1/chat/completions") {
        await handleChatCompletions(req, res, config);
        return log(res.statusCode);
      }
      if (req.method === "POST" && path === "/v1/messages") {
        await handleAnthropicMessages(req, res, config);
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
