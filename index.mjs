/**
 * MistralVibe2API — magpie / OpenCode provider plugin.
 *
 * Turns a Mistral Vibe API key into a provider every agent can use. Each
 * request is forwarded to Mistral's official Vibe endpoint
 * (https://api.mistral.ai/v1/chat/completions) with the fingerprint of the
 * Vibe CLI itself: the same bearer key and the same User-Agent as the
 * mistralai Python SDK the CLI ships, with every header that could name the
 * calling harness stripped.
 *
 * Add it with:
 *   magpie plugin add /path/to/MistralVibe2API
 *   magpie plugin login mistral-vibe
 */

import {
  loadConfig,
  MODELS,
  openAIModelsFromUpstream,
  sanitizeHeaders,
  UPSTREAM_BASE,
  vibeCatalogFromUpstream,
} from "./src/core.mjs";

const PROVIDER = "mistral-vibe";

/** Options accepted as the plugin's second argument (plugins.json "options"). */
function resolveOptions(options = {}) {
  return {
    upstreamBase: (options.upstreamBase ?? UPSTREAM_BASE).replace(/\/+$/, ""),
    userAgent: options.userAgent,
    extraHeaders: options.extraHeaders,
    usageUrl: options.usageUrl,
  };
}

// Kept local on purpose: magpie treats every exported function as a plugin,
// so the plugin itself is only reachable through the default { id, server }
// export below (the OpenCode v1 shape).
const MistralVibePlugin = async (_input, options = {}) => {
  const opts = resolveOptions(options);

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "Mistral Vibe",
        npm: "@ai-sdk/openai-compatible", // chat completions, as Mistral serves it
        api: opts.upstreamBase,
        models: MODELS,
      };
    },

    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "api",
          label: "Mistral Vibe API key",
          placeholder: "从 chat.mistral.ai/code/extensions 创建的 Vibe key",
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== "api") return {};
        const apiKey = auth.key;
        return {
          baseURL: opts.upstreamBase,
          apiKey,
          async fetch(input, init) {
            const url = typeof input === "string" ? input : input.url;
            const headers = sanitizeHeaders(init?.headers, {
              apiKey,
              userAgent: opts.userAgent,
              extraHeaders: opts.extraHeaders,
              body: init?.body,
            });
            return fetch(url, { ...init, headers });
          },
        };
      },
      // Mistral exposes no per-key usage endpoint (the admin usage API needs an
      // Enterprise admin key), so this stays empty unless a usageUrl is
      // configured. Returning no `used` keeps routing neutral, as documented.
      async usage(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== "api" || !opts.usageUrl) return {};
        try {
          const response = await fetch(opts.usageUrl, {
            headers: sanitizeHeaders(null, {
              apiKey: auth.key,
              userAgent: opts.userAgent,
              extraHeaders: opts.extraHeaders,
            }),
          });
          if (!response.ok) {
            return { error: `usage endpoint answered ${response.status}`, windows: [] };
          }
          const data = await response.json();
          const windows = [];
          if (data?.used != null && data?.limit != null) {
            windows.push({
              name: data.name ?? "monthly",
              used: Number(data.used),
              limit: Number(data.limit),
              unit: data.unit ?? "requests",
            });
          }
          return { plan: data?.plan, user: data?.user, windows };
        } catch (error) {
          return { error: String(error?.message ?? error), windows: [] };
        }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api") return provider.models;
        const headers = sanitizeHeaders(null, {
          apiKey: auth.key,
          userAgent: opts.userAgent,
          extraHeaders: opts.extraHeaders,
        });
        // The Vibe-surface catalog first: it is what the CLI itself reads, so
        // it names the models (and aliases) the Vibe allowance is served on.
        try {
          const catalog = await fetch(
            `${opts.upstreamBase}/model-catalog?surface=vibe-code`,
            { headers }
          );
          if (catalog.ok) {
            const data = await catalog.json();
            const merged = vibeCatalogFromUpstream(data, provider.models);
            if (Object.keys(merged).length) return merged;
          }
        } catch {
          // fall through to /v1/models
        }
        try {
          const response = await fetch(`${opts.upstreamBase}/models`, { headers });
          if (!response.ok) return provider.models;
          const data = await response.json();
          const merged = openAIModelsFromUpstream(data, provider.models);
          return Object.keys(merged).length ? merged : provider.models;
        } catch {
          return provider.models;
        }
      },
    },
  };
};

export default { id: PROVIDER, server: MistralVibePlugin };

// Helpers for tests; an object export is never treated as a plugin.
export const _internal = { resolveOptions, sanitizeHeaders, loadConfig };
