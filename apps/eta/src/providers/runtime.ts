import type {
  Api,
  CredentialStore,
  Model,
  MutableModels,
  Provider,
  ProviderStreams,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import type { ProviderRuntimeDefinition } from "./catalog";
import type { EtaModelConfig, EtaProviderConfig } from "./config-types";
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
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { providerDefinitionForKind } from "./catalog";
import {
  effectiveModel,
  MODEL_THINKING_LEVELS,
  modelThinkingLevels,
  sanitizeProviderHeaders,
} from "./config-types";
import { discoverModels } from "./discovery";

/** The pi-ai APIs this server builds providers for, loaded once. */
async function apiFor(
  adapter: ProviderRuntimeDefinition["adapter"],
): Promise<ProviderStreams> {
  if (adapter === "openai-responses") {
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

/** Headers as the wire takes them: `null` entries are removals, so they are not sent. */
function wireHeaders(
  provider: EtaProviderConfig,
): Record<string, string> | undefined {
  const configured = sanitizeProviderHeaders(provider.headers);
  if (configured === undefined) return undefined;
  const sent = Object.entries(configured).filter(
    (entry): entry is [string, string] => entry[1] !== null,
  );
  return sent.length === 0 ? undefined : Object.fromEntries(sent);
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
 */
function thinkingLevelMap(
  model: EtaModelConfig,
  runtime: ProviderRuntimeDefinition,
): ThinkingLevelMap {
  const levels = modelThinkingLevels(model);
  const mapped: Record<string, string | null | undefined> = {};
  for (const level of MODEL_THINKING_LEVELS) {
    if (level === "off") {
      // "none" is the OpenAI-compatible disable; a provider that has no off switch says null.
      mapped[level] =
        runtime.thinking === "zai"
          ? null
          : levels.includes("off")
            ? "none"
            : null;
      continue;
    }
    mapped[level] = levels.includes(level) ? level : null;
  }
  return mapped as ThinkingLevelMap;
}

/** One model, as the runtime takes it. */
function runtimeModel(
  provider: EtaProviderConfig,
  configured: EtaModelConfig,
  headers: Record<string, string> | undefined,
  runtime: ProviderRuntimeDefinition,
): Model<"openai-completions"> {
  const model = effectiveModel(configured);
  const contextWindow = model.contextWindow ?? 128_000;
  return {
    id: model.id,
    name: model.name ?? model.id,
    api: "openai-completions",
    provider: provider.id,
    baseUrl: provider.baseUrl,
    ...(headers === undefined ? {} : { headers }),
    reasoning: model.reasoning ?? false,
    ...(model.reasoning === true
      ? { thinkingLevelMap: thinkingLevelMap(model, runtime) }
      : {}),
    input: model.input ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: model.maxTokens ?? Math.min(8_192, contextWindow),
  } as Model<"openai-completions">;
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
async function buildProvider(
  provider: EtaProviderConfig,
  options: { fetch?: typeof fetch } = {},
): Promise<Provider<Api>> {
  const definition = providerDefinitionForKind(provider.kind);
  if (definition === undefined)
    throw new Error(
      `unsupported provider kind: ${String(provider.kind ?? "openai-compatible")}`,
    );
  const headers = wireHeaders(provider);
  const models = provider.models.map((configured) =>
    runtimeModel(provider, configured, headers, definition.runtime),
  );
  const api = await apiFor(definition.runtime.adapter);
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
    ...(definition.discovery.adapter === "openai-models"
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
            return discovered.models.map((configured) =>
              runtimeModel(provider, configured, headers, definition.runtime),
            );
          },
        }
      : {}),
  });
}
