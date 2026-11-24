/**
 * Shared core for MistralVibe2API.
 *
 * What the official Vibe CLI actually sends (verified against the
 * mistralai/mistral-vibe source, v3.1.5):
 *
 *   POST https://api.mistral.ai/v1/chat/completions
 *   Authorization: Bearer <Vibe API key>          (key created at
 *                                                    chat.mistral.ai/code/extensions)
 *   User-Agent: speakeasy-sdk/python 3.5.0 ...    (the mistralai Python SDK,
 *                                                   pinned at 3.5.0)
 *   Accept: text/event-stream                     (when stream: true)
 *   Content-Type: application/json
 *
 * The SDK is Speakeasy-generated and sets nothing else besides user-agent.
 * From 2026-12-01 Mistral bills usage made through non-Mistral products
 * against the free API allowance instead of the Vibe allowance, so the proxy
 * rewrites every request to look exactly like the Vibe CLI: same endpoint,
 * same bearer key, same User-Agent, and nothing that names the harness in
 * front of it.
 */

export const UPSTREAM_BASE = "https://api.mistral.ai/v1";
export const UPSTREAM_ORIGIN = "https://api.mistral.ai";

/**
 * User-Agent of the official Vibe CLI. The CLI pins mistralai==3.5.0
 * (see mistral-vibe pyproject.toml); that SDK version reports:
 *   speakeasy-sdk/python 3.5.0 2.935.1 1.0.0 mistralai
 * Override with the VIBE_USER_AGENT env var (or plugin option) when the SDK
 * version moves.
 */
export const VIBE_SDK_USER_AGENT = "speakeasy-sdk/python 3.5.0 2.935.1 1.0.0 mistralai";

/**
 * The only headers forwarded from the client. Everything else the agent sent
 * (user-agent, x-stainless-*, origin, referer, x-api-key, anthropic-*, …) is
 * dropped: the upstream must not be able to tell which harness is calling.
 */
const ALLOWED_CLIENT_HEADERS = new Set(["content-type", "accept"]);

/** Headers we must never forward verbatim. */
const DROP_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
  "expect",
  "accept-encoding",
  "cookie",
  "user-agent",
  "referer",
  "origin",
  "x-real-ip",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "forwarded",
  "via",
]);

/** True when a JSON body string asks for a streamed completion. */
export function isStreamBody(body) {
  if (typeof body !== "string") return false;
  return /"stream"\s*:\s*true/.test(body);
}

/**
 * Build the headers for an upstream request.
 *
 * @param incoming  client headers (Headers | plain object | array | undefined)
 * @param opts.apiKey        Vibe key to send as the bearer token
 * @param opts.userAgent     User-Agent to impersonate (default: Vibe CLI SDK)
 * @param opts.extraHeaders  extra headers to set, e.g. { origin: "https://chat.mistral.ai" }
 * @param opts.body          request body (string), used to pick the Accept header
 * @returns Headers carrying only the official-client fingerprint
 */
export function sanitizeHeaders(incoming, opts = {}) {
  const headers = new Headers();

  if (incoming) {
    const src = incoming instanceof Headers ? incoming : new Headers(incoming);
    for (const [name, value] of src) {
      const lower = name.toLowerCase();
      if (!ALLOWED_CLIENT_HEADERS.has(lower)) continue;
      if (DROP_HEADERS.has(lower)) continue;
      headers.set(lower, value);
    }
  }

  const stream = isStreamBody(opts.body);
  const clientAccept = headers.get("accept");
  if (stream) {
    headers.set("accept", "text/event-stream");
  } else if (!clientAccept || clientAccept.trim() === "*/*") {
    // the SDK asks for JSON explicitly; a bare */* tells Mistral nothing
    headers.set("accept", "application/json");
  }
  if (!headers.has("content-type")) headers.set("content-type", "application/json");

  if (opts.apiKey) headers.set("authorization", `Bearer ${opts.apiKey}`);
  headers.set("user-agent", opts.userAgent ?? VIBE_SDK_USER_AGENT);

  if (opts.extraHeaders) {
    for (const [name, value] of Object.entries(opts.extraHeaders)) {
      headers.set(name, String(value));
    }
  }

  return headers;
}

/**
 * Which key a request should use. An explicitly configured key (env var or
 * plugin login) wins, so agents can send a placeholder; the client's own
 * bearer token is only used when nothing is configured, or when
 * ALLOW_CLIENT_KEY is on (multi-tenant proxy).
 */
export function resolveApiKey(clientHeaders, config) {
  const auth = clientHeaders?.authorization ?? clientHeaders?.["Authorization"];
  let clientKey = null;
  if (typeof auth === "string" && /^bearer\s+/i.test(auth)) {
    clientKey = auth.replace(/^bearer\s+/i, "").trim();
  }
  clientKey = clientKey || clientHeaders?.["x-api-key"] || null;

  if (config?.apiKey && !config?.allowClientKey) return config.apiKey;
  if (config?.apiKey && config?.allowClientKey && clientKey) return clientKey;
  if (config?.apiKey) return config.apiKey;
  return clientKey || null;
}

/**
 * Static model catalog. Names verified against the live endpoints with a Vibe
 * key: `GET /v1/models` and `GET /v1/model-catalog?surface=vibe-code`.
 *
 * The `mistral-vibe-cli-*` entries are the wire names the Vibe CLI itself
 * sends (the harness's LocalModelRoute default is `mistral-vibe-cli-latest`,
 * an alias of mistral-medium-latest). Mistral's Vibe surface serves them, so
 * the proxy offers them first: usage is most likely attributed to the Vibe
 * allowance when the request carries a Vibe-surface model.
 */
export const MODELS = {
  "mistral-vibe-cli-latest": {
    name: "Mistral Vibe CLI (Medium 3.5)",
    limit: { context: 262144, output: 32768 },
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text", "image"] },
    attachment: true,
  },
  "mistral-vibe-cli-with-tools": {
    name: "Mistral Vibe CLI with Tools (Medium 3.5)",
    limit: { context: 262144, output: 32768 },
    reasoning: true,
    tool_call: true,
  },
  "mistral-vibe-cli-fast": {
    name: "Mistral Vibe CLI Fast",
    limit: { context: 262144, output: 32768 },
    tool_call: true,
  },
  "mistral-medium-latest": {
    name: "Mistral Medium 3.5",
    limit: { context: 262144, output: 32768 },
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text", "image"] },
    attachment: true,
  },
  "mistral-large-4-0": {
    name: "Mistral Large 4",
    limit: { context: 1048576, output: 32768 },
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text", "image"] },
    attachment: true,
  },
  "mistral-large-latest": {
    name: "Mistral Large 3",
    limit: { context: 262144, output: 32768 },
    reasoning: true,
    tool_call: true,
  },
  "mistral-small-latest": {
    name: "Mistral Small 4",
    limit: { context: 131072, output: 32768 },
    tool_call: true,
  },
  "codestral-latest": {
    name: "Codestral",
    limit: { context: 262144, output: 32768 },
    tool_call: true,
  },
  "magistral-medium-latest": {
    name: "Magistral Medium",
    limit: { context: 262144, output: 32768 },
    reasoning: true,
    tool_call: true,
  },
  "magistral-small-latest": {
    name: "Magistral Small",
    limit: { context: 131072, output: 32768 },
    reasoning: true,
    tool_call: true,
  },
  "ministral-3b-latest": {
    name: "Ministral 3B",
    limit: { context: 131072, output: 32768 },
    tool_call: true,
  },
  "ministral-8b-latest": {
    name: "Ministral 8B",
    limit: { context: 131072, output: 32768 },
    tool_call: true,
  },
  "ministral-14b-latest": {
    name: "Ministral 14B",
    limit: { context: 131072, output: 32768 },
    tool_call: true,
  },
  "pixtral-large-latest": {
    name: "Pixtral Large",
    limit: { context: 131072, output: 32768 },
    tool_call: true,
    modalities: { input: ["text", "image"] },
    attachment: true,
  },
  "zai-glm-5-3": {
    name: "GLM 5.3 (Mistral Hosted)",
    limit: { context: 1048576, output: 32768 },
    reasoning: true,
    tool_call: true,
  },
  "zai-glm-5-3-flash": {
    name: "GLM 5.3 Flash (Mistral Hosted)",
    limit: { context: 262144, output: 32768 },
    reasoning: true,
    tool_call: true,
  },
  "deepseek-v4-1-flash-1017": {
    name: "DeepSeek V4.1 Flash (Mistral Hosted)",
    limit: { context: 1048576, output: 32768 },
    reasoning: true,
    tool_call: true,
  },
};

/** Model ids that accept an Anthropic-style vision attachment. */
export function openAIModelsFromUpstream(data, baseModels) {
  const base = baseModels ?? MODELS;
  const out = {};
  for (const model of data?.data ?? []) {
    const id = model?.id;
    if (typeof id !== "string" || !id) continue;
    const known = base[id];
    out[id] = known
      ? { ...known, id }
      : {
          name: id,
          id,
          limit: { context: 131072, output: 32768 },
          tool_call: true,
        };
  }
  return out;
}

/**
 * Build a model list from the Vibe-surface catalog
 * (`GET /v1/model-catalog?surface=vibe-code`). Each entry carries its own
 * aliases, context window and capabilities, and every alias resolves to the
 * same entry on Mistral's side.
 */
export function vibeCatalogFromUpstream(data, baseModels) {
  const base = baseModels ?? MODELS;
  const out = {};
  for (const entry of data?.models ?? []) {
    const id = entry?.id;
    if (typeof id !== "string" || !id) continue;
    const known = base[id];
    const context = Number(entry?.max_context_length) || 131072;
    const model = known
      ? { ...known }
      : {
          name: entry?.label ?? id,
          limit: { context, output: 32768 },
          tool_call: true,
        };
    model.name = entry?.label ?? model.name ?? id;
    model.limit = { ...model.limit, context };
    if (Array.isArray(entry?.aliases)) {
      model.aliases = entry.aliases;
    }
    out[id] = model;
  }
  return out;
}

function parseJson(value) {
  if (!value) return undefined;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function truthy(value) {
  return value === "1" || value === "true" || value === "yes";
}

/** Build a runtime config from environment variables. */
export function loadConfig(env = {}) {
  return {
    upstreamBase: (env.MISTRAL_UPSTREAM_BASE ?? UPSTREAM_BASE).replace(/\/+$/, ""),
    userAgent: env.VIBE_USER_AGENT ?? VIBE_SDK_USER_AGENT,
    extraHeaders: parseJson(env.VIBE_EXTRA_HEADERS),
    apiKey: env.MISTRAL_API_KEY || env.VIBE_API_KEY || null,
    allowClientKey: truthy(env.ALLOW_CLIENT_KEY),
    modelMap: parseJson(env.MODEL_MAP),
    quiet: truthy(env.QUIET),
  };
}

/** Apply the optional model alias map to a model id. */
export function mapModel(model, modelMap) {
  if (!modelMap || typeof model !== "string") return model;
  return modelMap[model] ?? model;
}
