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

/* ------------------------------------------------------------------ */
/* Billing: what the Vibe CLI's own account read uses                 */
/* ------------------------------------------------------------------ */

/**
 * Read the plan and the monthly budgets from Mistral's public billing API.
 * This is what the CLI itself calls (vibe/app_server/_billing.py):
 *
 *   GET {api_base}/billing/subscription  -> { plan_name, vibe_payg_enabled, ... }
 *   GET {api_base}/billing/budget        -> { vibe_budget, api_budget, ... }
 *
 * Both accept the Vibe API key as the platform credential. /budget needs the
 * see_org_inference_usage permission on the key; a 403 there is normal for
 * members without it, so failures degrade to null instead of throwing.
 */
export async function fetchBilling(apiKey, opts = {}) {
  const base = (opts.upstreamBase ?? UPSTREAM_BASE).replace(/\/+$/, "");
  const headers = sanitizeHeaders(null, {
    apiKey,
    userAgent: opts.userAgent,
    extraHeaders: opts.extraHeaders,
  });
  const out = { subscription: null, budget: null };
  const [subRes, budRes] = await Promise.allSettled([
    fetch(`${base}/billing/subscription`, { headers }),
    fetch(`${base}/billing/budget`, { headers }),
  ]);
  if (subRes.status === "fulfilled" && subRes.value.ok) {
    out.subscription = await subRes.value.json().catch(() => null);
  }
  if (budRes.status === "fulfilled" && budRes.value.ok) {
    out.budget = await budRes.value.json().catch(() => null);
  }
  return out;
}

/** Seconds from now until an ISO reset time, or undefined when unparseable. */
function resetSpan(resetAt) {
  if (typeof resetAt !== "string") return undefined;
  const ms = Date.parse(resetAt) - Date.now();
  return ms > 0 ? Math.round(ms / 1000) : undefined;
}

function money(amount, currency) {
  const symbol = currency === "USD" ? "$" : "";
  return `${symbol}${amount.toFixed(2)}`;
}

/**
 * Turn a /billing/budget response into magpie usage windows: the Vibe Code
 * allowance and the API allowance are separate pools (confirmed live: $300
 * and $30 per month, both resetting on the 1st UTC).
 */
export function budgetToWindows(budget) {
  const windows = [];
  for (const [key, name] of [
    ["vibe_budget", "Vibe Code"],
    ["api_budget", "API"],
  ]) {
    const pool = budget?.[key];
    if (!pool || typeof pool.usage_percentage !== "number") continue;
    const limit = Number(pool.initial_budget) || 0;
    const used = Number(pool.usage_percentage);
    const amount = Math.round(((limit * used) / 100) * 100) / 100;
    windows.push({
      name,
      used,
      limit,
      amount,
      unit: pool.currency ?? "USD",
      resetsAt: pool.reset_at ?? undefined,
      span: resetSpan(pool.reset_at),
      display: `${money(amount, pool.currency)} / ${money(limit, pool.currency)}`,
      payg_enabled: pool.payg_enabled ?? undefined,
    });
  }
  return windows;
}

/**
 * USD per million tokens, from mistral.ai/pricing/api (standard tier).
 * The CLI prices a completion with the same numbers (its CompletionPricing);
 * models the Vibe plan includes without a published rate (Medium 3.5) carry
 * no price, so their cost reads as unknown rather than zero.
 */
export const MODEL_PRICES = {
  "mistral-vibe-cli-latest": null, // Medium 3.5: no published API rate
  "mistral-vibe-cli-with-tools": null,
  "mistral-vibe-cli-fast": null,
  "mistral-medium-latest": null,
  "mistral-large-4-0": { input: 0.7, cachedInput: 0.07, output: 2.1 },
  "mistral-large-latest": { input: 0.7, cachedInput: 0.07, output: 2.1 },
  "mistral-small-latest": { input: 0.15, cachedInput: 0.015, output: 0.6 },
  "codestral-latest": { input: 0.3, cachedInput: 0.03, output: 0.9 },
  "zai-glm-5-3": { input: 1.4, cachedInput: 0.14, output: 4.4 },
  "zai-glm-5-3-flash": { input: 0.15, cachedInput: 0.03, output: 0.5 },
  "zai-glm-5-3-flash-vibe-free": { input: 0.15, cachedInput: 0.03, output: 0.5 },
  "deepseek-v4-1-flash-1017": { input: 0.3, cachedInput: 0.007, output: 1.2 },
  "ministral-14b-latest": { input: 0.2, cachedInput: 0.02, output: 0.2 },
  "ministral-8b-latest": { input: 0.15, cachedInput: 0.015, output: 0.15 },
  "ministral-3b-latest": { input: 0.1, cachedInput: 0.01, output: 0.1 },
};

/**
 * Cost of one completion in USD, with the Vibe CLI's own formula
 * (harness _completion_budget.py, CompletionPricing.cost): uncached input at
 * the input rate, cached input at the cached rate, output at the output rate.
 * Returns null when the model has no published price.
 */
export function computeCost(usage, price) {
  if (!price) return null;
  const input = usage?.prompt_tokens ?? 0;
  const output = usage?.completion_tokens ?? 0;
  const cached = Math.min(input, usage?.prompt_tokens_details?.cached_tokens ?? 0);
  const cachedRate = price.cachedInput ?? price.input;
  return (
    ((input - cached) * price.input + cached * cachedRate + output * price.output) /
    1_000_000
  );
}

/** Empty per-model usage record for the stats aggregator. */
export function emptyUsageRecord() {
  return {
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    cost_usd: 0,
    cost_known: true,
  };
}

/**
 * Pull the last `{ model, usage }` out of an SSE buffer (or a non-streaming
 * JSON body). Mistral reports usage on the final chunk, so the last object
 * carrying a usage field wins. Returns null when the buffer holds none.
 */
export function extractUsage(buffer) {
  if (!buffer) return null;
  const text = typeof buffer === "string" ? buffer : buffer.toString("utf8");
  let found = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload.startsWith("{")) continue;
    try {
      const chunk = JSON.parse(payload);
      if (chunk?.usage && typeof chunk.usage === "object") {
        found = { model: chunk.model, usage: chunk.usage };
      }
    } catch {
      // partial or keep-alive line
    }
  }
  if (found) return found;
  // non-streaming body: the whole text is one JSON object
  try {
    const whole = JSON.parse(text);
    if (whole?.usage && typeof whole.usage === "object") {
      return { model: whole.model, usage: whole.usage };
    }
  } catch {
    // not a complete JSON body
  }
  return null;
}

/**
 * Fold one response's usage into a record. `cached_input_tokens` is the cache
 * hit count Mistral reports in prompt_tokens_details; `cache_write_tokens`
 * the cache writes; both optional like in the CLI's RustTokenUsage.
 */
export function accumulateUsage(record, usage, price) {
  const next = {
    requests: record.requests + 1,
    input_tokens: record.input_tokens + (usage?.prompt_tokens ?? 0),
    output_tokens: record.output_tokens + (usage?.completion_tokens ?? 0),
    cached_input_tokens:
      record.cached_input_tokens + (usage?.prompt_tokens_details?.cached_tokens ?? 0),
    cache_write_tokens:
      record.cache_write_tokens + (usage?.prompt_tokens_details?.cache_write_tokens ?? 0),
    reasoning_tokens:
      record.reasoning_tokens +
      (usage?.completion_tokens_details?.reasoning_tokens ?? 0),
    cost_usd: record.cost_usd,
    cost_known: record.cost_known,
  };
  const cost = computeCost(usage, price);
  if (cost == null) {
    next.cost_known = false;
  } else {
    next.cost_usd = Math.round((record.cost_usd + cost) * 1e6) / 1e6;
  }
  return next;
}
