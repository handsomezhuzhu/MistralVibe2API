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
 * Every account's key is typed — Vibe key or API key — at login and, for
 * accounts that predate the typing, on first use: the type is written back
 * to the account so it costs one whoami call per key, not one per read. The
 * usage hook then reports the allowance pool that key's usage is actually
 * billed to, which is what the routing preference keys off.
 *
 * Add it with:
 *   magpie plugin add /path/to/MistralVibe2API
 *   magpie plugin login mistral-vibe
 */

import {
  budgetToWindows,
  DEFAULT_CONSOLE_BASE,
  fetchBilling,
  identifyKey,
  loadConfig,
  MODELS,
  openAIModelsFromUpstream,
  poolForKeyType,
  sanitizeHeaders,
  UPSTREAM_BASE,
  vibeCatalogFromUpstream,
} from "./src/core.mjs";

const PROVIDER = "mistral-vibe";
/** Which key type's pool routing should prefer: "vibe" | "api" | "quota". */
const KEY_PREFERENCES = ["vibe", "api", "quota"];

/** Options accepted as the plugin's second argument (plugins.json "options"). */
function resolveOptions(options = {}) {
  const preference = KEY_PREFERENCES.includes(options.keyPreference)
    ? options.keyPreference
    : "vibe";
  return {
    upstreamBase: (options.upstreamBase ?? UPSTREAM_BASE).replace(/\/+$/, ""),
    consoleBase: (options.consoleBase ?? DEFAULT_CONSOLE_BASE).replace(/\/+$/, ""),
    userAgent: options.userAgent,
    extraHeaders: options.extraHeaders,
    usageUrl: options.usageUrl,
    keyPreference: preference,
  };
}

// Kept local on purpose: magpie treats every exported function as a plugin,
// so the plugin itself is only reachable through the default { id, server }
// export below (the OpenCode v1 shape).
const MistralVibePlugin = async (input, options = {}) => {
  const opts = resolveOptions(options);
  const client = input?.client;

  /**
   * The account's key type: what authorize stored, or a fresh whoami read
   * for accounts that signed in before the type was recorded. A type read
   * this way is written back to the account, so recognition costs one
   * whoami call per key rather than one per read.
   *
   * The write follows the community pattern for a non-conditional
   * auth.set: re-read the account and drop the write when anything changed
   * underneath us (a sign-out or refresh that landed while whoami was
   * pending), and treat a failed write as best effort — this read still
   * uses the detected type.
   */
  async function keyTypeOf(getAuth) {
    const auth = await getAuth();
    const stored = auth?.metadata?.keyType;
    if (stored === "vibe" || stored === "api") return stored;

    const info = await identifyKey(auth?.key, opts);
    if (info.keyType !== "vibe" && info.keyType !== "api") return info.keyType;

    if (client?.auth?.set && auth) {
      try {
        const snapshot = JSON.stringify(auth);
        if (JSON.stringify(await getAuth()) === snapshot) {
          await client.auth.set({
            path: { id: PROVIDER },
            body: {
              ...auth,
              metadata: {
                ...auth.metadata,
                keyType: info.keyType,
                planType: info.planType,
                planName: info.planName,
              },
            },
          });
        }
      } catch {
        // persisting is best effort: routing still uses the detected type
      }
    }
    return info.keyType;
  }

  /**
   * Which pool routing reads for this account, under the preference:
   * "quota" counts every key's own pool (routing balances by what is
   * left), while "vibe"/"api" count only the preferred type's pool — the
   * other type gets "none", its windows all aside: shown on the card but
   * never pulling traffic, still there for failover once the preferred
   * pool is spent.
   */
  function countingPool(keyType, preference) {
    if (preference === "quota") return "all";
    const own = poolForKeyType(keyType);
    return own === poolForKeyType(preference) ? own : "none";
  }

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
          label: "Mistral API key",
          placeholder: "mstrl_…",
          prompts: [
            {
              type: "password",
              key: "apiKey",
              message: "Mistral API key",
              placeholder: "mstrl_…（Vibe key 或 API key 均可，登录时会标明类型）",
              validate: (value) =>
                String(value ?? "").trim() ? undefined : "key is required",
            },
          ],
          /**
           * Validate the key and record what it is. The account is labelled
           * "vibe · …1f01" or "api · …1f01" so the two kinds are tellable
           * apart in the account list, and the type is kept in metadata for
           * the usage hook's pool choice.
           */
          async authorize(inputs) {
            const key = String(inputs?.apiKey ?? inputs?.key ?? "").trim();
            if (!key) return { type: "failed", error: "key is required" };

            const info = await identifyKey(key, opts);
            if (info.status === 401 || info.status === 403) {
              return {
                type: "failed",
                error: `Mistral refused the key (${info.status}); check it and try again`,
              };
            }
            const keyType = info.keyType; // "vibe" | "api" | "unknown"
            const tail = key.length > 4 ? `…${key.slice(-4)}` : key;
            return {
              type: "success",
              key,
              accountId: `${keyType} · ${tail}`,
              metadata: {
                keyType,
                planType: info.planType,
                planName: info.planName,
                checkedAt: new Date().toISOString(),
              },
            };
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== "api") return {};
        const apiKey = auth.key;
        // Accounts that signed in before key typing existed get recognised
        // here, once: the type is written back for later reads.
        keyTypeOf(getAuth).catch(() => {});
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
      // Mistral exposes the plan and both monthly allowances (Vibe Code and
      // API are separate pools) on the public billing API the CLI itself
      // reads: /v1/billing/subscription and /v1/billing/budget. /budget needs
      // the see_org_inference_usage permission; without it we still report
      // the plan. A usageUrl option overrides all of this.
      async usage(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== "api") return {};

        if (opts.usageUrl) {
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
        }

        try {
          const keyType = await keyTypeOf(getAuth);
          const billing = await fetchBilling(auth.key, opts);
          const planName = billing.subscription?.plan_name ?? auth.metadata?.planName;
          const plan = planName
            ? `${planName} · ${keyType === "unknown" ? "unknown" : keyType} key`
            : undefined;

          if (!billing.budget) {
            // 403/404 on /budget (no permission, self-hosted): plan only.
            return plan ? { plan } : {};
          }
          const windows = budgetToWindows(
            billing.budget,
            countingPool(keyType, opts.keyPreference)
          );
          if (!windows.length) return plan ? { plan } : {};
          return { plan, windows };
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
