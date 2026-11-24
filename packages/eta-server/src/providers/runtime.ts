/**
 * Config → Models: what a session actually generates through.
 *
 * eta-agent's `provider-runtime.ts`, ported. Each configured provider becomes a pi-ai
 * `Provider`: a base URL, auth that reads the key from the config file, a static model list
 * built from the capabilities the config declares, and the API implementation for the kind
 * (`openai-completions` or `openai-responses`).
 *
 * Three details carry most of the weight:
 *
 * - **Headers reach the request.** Provider headers are sanitised on the way in (a hand-edited
 *   config must not smuggle a newline into a header) and attached to every model of that
 *   provider, which is how a custom `User-Agent` gets to the endpoint. A `null` value suppresses
 *   a header the transport would otherwise add.
 * - **A model's thinking levels are declared, not guessed.** The `thinkingLevelMap` says, per
 *   level, what the provider should be sent — `null` meaning "this model does not take it". That
 *   is the same vocabulary `thinkingLevelsFor` reads on the other side.
 * - **One broken provider does not take the rest down.** Building a provider can fail (an
 *   unknown kind, a base URL that will not parse). That failure is reported and skipped: a
 *   user with three providers and a typo in one still has two that work, which is the whole
 *   difference between a settings page and a wall.
 */

import type {
  Api,
  CredentialStore,
  Model,
  MutableModels,
  Provider,
  ProviderStreams,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import type {
  ModelApi,
  ModelSource,
  ProviderKind,
} from "@eta/client-contracts";
import type { KernelModels } from "@eta/core";
import type { EtaModelConfig, EtaProviderConfig } from "./config-types";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { modelSource } from "@eta/client-contracts";
import { attributionHeaders } from "./attribution";
import { catalogCompat, piModels } from "./catalog";
import {
  effectiveModel,
  MODEL_THINKING_LEVELS,
  modelThinkingLevels,
} from "./config-types";
import { discoverModels } from "./discovery";

/** The pi-ai APIs this server builds providers for, loaded on first use. */
async function apiFor(api: ModelApi): Promise<ProviderStreams> {
  if (api === "openai-responses") {
    const module = await import("@earendil-works/pi-ai/api/openai-responses");
    return {
      stream: module.stream,
      streamSimple: module.streamSimple,
    } as ProviderStreams;
  }
  const module = await import("@earendil-works/pi-ai/api/openai-completions");
  return {
    stream: module.stream,
    streamSimple: module.streamSimple,
  } as ProviderStreams;
}

/** The protocol a provider's models speak unless a model says otherwise. */
function kindApi(source: ModelSource): ModelApi {
  return source.api ?? "openai-completions";
}

/**
 * The wire settings one model takes. A gateway pi-ai describes (OpenCode) says them per model
 * behind it (DeepSeek's thinking format, which fields a gateway takes), which models.dev does
 * not; any other model gets its kind's from the definition.
 */
function compatFor(
  kind: ProviderKind | undefined,
  id: string,
  api: ModelApi,
): Model<Api>["compat"] {
  if (kind !== undefined && modelSource(kind)?.pi === "gateway") {
    const known = piModels(kind).find(
      (model) => model.id === id && model.api === api,
    );
    if (known !== undefined) return known.compat;
  }
  return api === "openai-completions"
    ? (catalogCompat(kind) as Model<Api>["compat"])
    : undefined;
}

/** Auth that reads the key out of the config file. Keyless endpoints get a placeholder. */
function apiKeyAuth(provider: EtaProviderConfig): {
  apiKey: {
    name: string;
    resolve: () => Promise<{ auth: { apiKey: string }; source: string }>;
  };
} {
  return {
    apiKey: {
      name: `${provider.id} key (eta config)`,
      async resolve() {
        return {
          auth: {
            apiKey:
              provider.apiKey && provider.apiKey.length > 0
                ? provider.apiKey
                : "eta-no-key",
          },
          source: "eta config",
        };
      },
    },
  };
}

/**
 * How this model's thinking levels map onto the provider's own words.
 *
 * Every level is stated, because a missing key would leave the provider's default in charge and
 * a `null` is the only way to say "this model does not take this level". `off` becomes the
 * provider's disable token where one exists.
 *
 * A model that reasons at levels it does not name has them passed on as asked: what it takes is
 * not known, so the endpoint decides, which is what the agent pickers say of such a model
 * (`etaModelThinking` in `@eta/client-contracts`).
 */
function thinkingLevelMap(
  model: EtaModelConfig,
  source: ModelSource,
): ThinkingLevelMap {
  const levels = modelThinkingLevels(model);
  const facts = effectiveModel(model);
  const unknown =
    facts.reasoning === true &&
    facts.thinkingMode !== "no" &&
    (facts.reasoningEfforts ?? []).length === 0;
  const mapped: Record<string, string | null | undefined> = {};
  for (const level of MODEL_THINKING_LEVELS) {
    if (level === "off") {
      // "none" is the OpenAI-compatible disable; a provider that has no off switch says null.
      const off =
        levels.includes("off") || (unknown && facts.thinkingMode === "both");
      mapped[level] = source.noThinkingOff !== true && off ? "none" : null;
      continue;
    }
    mapped[level] = unknown || levels.includes(level) ? level : null;
  }
  return mapped as ThinkingLevelMap;
}

/** One model, as the runtime takes it. */
function runtimeModel(
  provider: EtaProviderConfig,
  configured: EtaModelConfig,
  headers: Record<string, string> | undefined,
  source: ModelSource,
): Model<ModelApi> {
  const model = effectiveModel(configured);
  const contextWindow = model.contextWindow ?? 128_000;
  const api = model.api ?? kindApi(source);
  const compat =
    provider.kind === undefined
      ? undefined
      : compatFor(provider.kind, model.id, api);
  return {
    id: model.id,
    name: model.name ?? model.id,
    api,
    provider: provider.id,
    baseUrl: provider.baseUrl,
    ...(headers === undefined ? {} : { headers }),
    reasoning: model.reasoning ?? false,
    ...(model.reasoning === true
      ? { thinkingLevelMap: thinkingLevelMap(model, source) }
      : {}),
    input: model.input ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    ...(model.contextWindow === undefined
      ? { assumedContextWindow: true }
      : {}),
    maxTokens: model.maxTokens ?? Math.min(8_192, contextWindow),
    // pi-ai opts tool calls into `strict` by default, and a provider either ignores the
    // key or rejects it outright — Gemini's FunctionDeclaration has four fields and
    // `strict` is not one of them, so a strict key costs every tool a 400. Nothing here
    // ever asked for it: eta declares no constrained sampling on any tool, so the key has
    // only ever gone out as `strict: false`. Turning it off also keeps the raw JSON
    // Schema, instead of the strict dialect `makeStrictJsonSchema` would rewrite it into.
    compat: { ...compat, supportsStrictMode: false },
    // Not a pi-ai field: read by `withSessionHeader`, which knows the session.
    ...(source.sessionHeader === undefined
      ? {}
      : { sessionHeader: source.sessionHeader }),
  } as Model<ModelApi>;
}

/**
 * One session's view of a model layer: a model whose provider routes conversations by a header
 * (OpenCode's `x-opencode-session`, in its definition) gets the session's id in it on every
 * request. Every other request goes out exactly as it was asked for — pi-ai's own `sessionId`
 * option is deliberately not used, because it also turns on prompt-cache keys and session headers
 * for every other provider.
 */
export function withSessionHeader(
  models: KernelModels,
  sessionId: string,
): KernelModels {
  const scoped = <O extends { headers?: Record<string, string | null> }>(
    model: Model<Api>,
    options: O | undefined,
  ): O | undefined => {
    const header = (model as { sessionHeader?: unknown }).sessionHeader;
    if (typeof header !== "string" || sessionId.length === 0) return options;
    return {
      ...options,
      headers: { ...options?.headers, [header]: sessionId },
    } as O;
  };
  return {
    getModel: (provider, id) => models.getModel(provider, id),
    streamSimple: (model, context, options) =>
      models.streamSimple(model, context, scoped(model, options)),
    completeSimple: (model, context, options) =>
      models.completeSimple(model, context, scoped(model, options)),
  };
}

/** What one provider could not be built for, and why. */
export interface ProviderBuildFailure {
  id: string;
  error: string;
}

export interface BuildModelsResult {
  models: MutableModels | undefined;
  /** Providers that could not be built; the rest are in `models`. */
  failed: ProviderBuildFailure[];
}

/**
 * Build the model layer from a config.
 *
 * Asynchronous because the API implementations load lazily (a process that never makes a request
 * should not pay for the transport). `undefined` when there is nothing to build, which a caller
 * reads as "no providers configured" — not as an error.
 */
export async function buildModels(
  providers: readonly EtaProviderConfig[],
  options: {
    credentials?: CredentialStore;
    /** The HTTP client discovery uses. A test supplies one; production uses `fetch`. */
    fetch?: typeof fetch | undefined;
    warn?: (message: string) => void;
  } = {},
): Promise<BuildModelsResult> {
  const failed: ProviderBuildFailure[] = [];
  if (providers.length === 0) return { models: undefined, failed };
  const models = createModels(
    options.credentials === undefined
      ? {}
      : { credentials: options.credentials },
  );
  for (const provider of providers) {
    try {
      models.setProvider(await buildProvider(provider, options));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ id: provider.id, error: message });
      options.warn?.(
        `[eta-server] provider ${provider.id} is unusable: ${message}`,
      );
    }
  }
  return { models, failed };
}

/** One provider, built. Throws with the reason when the kind has no runtime. */
export async function buildProvider(
  provider: EtaProviderConfig,
  options: { fetch?: typeof fetch } = {},
): Promise<Provider<Api>> {
  const source = modelSource(provider.kind);
  if (source === undefined)
    throw new Error(
      `unsupported provider kind: ${String(provider.kind ?? "openai-compatible")}`,
    );
  const headers = attributionHeaders(provider.baseUrl, provider.headers);
  const models = provider.models.map((configured) =>
    runtimeModel(provider, configured, headers, source),
  );
  // One implementation per protocol the models use: a provider can mix them (OpenCode), and
  // pi-ai dispatches each model to the one its `api` names.
  const api: Partial<Record<ModelApi, ProviderStreams>> = {};
  for (const name of new Set([
    kindApi(source),
    ...models.map((model) => model.api),
  ]))
    api[name] = await apiFor(name);
  return createProvider({
    id: provider.id,
    ...(provider.name === undefined ? {} : { name: provider.name }),
    baseUrl: provider.baseUrl,
    ...(headers === undefined ? {} : { headers }),
    auth: apiKeyAuth(provider) as never,
    models,
    api,
    // A provider that publishes its model list gets a refresh that asks it — with the same
    // headers and key as a request, which is the only way a custom User-Agent endpoint can
    // have working chat and a working model list at the same time.
    ...(source.models !== "listed"
      ? {
          fetchModels: async (context: { signal: AbortSignal }) => {
            const discovered = await discoverModels({
              reference: provider,
              apiKey: provider.apiKey,
              headers: provider.headers,
              signal: context.signal,
              ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            });
            if (discovered.error !== undefined)
              throw new Error(discovered.error);
            return discovered.models
              .filter((model) => model.deprecated !== true)
              .map((configured) =>
                runtimeModel(provider, configured, headers, source),
              );
          },
        }
      : {}),
  });
}
