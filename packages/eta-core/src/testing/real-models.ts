/**
 * Real models for tests that talk to a provider (REFACTOR.md §2.2).
 *
 * Nothing here knows a provider id, a base URL, or a model name: the caller
 * passes plain data, exactly the shape a host reads from its own configuration
 * file. That keeps the smoke test honest — it tests the seam with whatever
 * model the machine is configured for, not with a name baked into the source.
 *
 * The wiring mirrors what a real host does for an [OI]-compatible endpoint:
 * one provider, a static model list, and an auth resolver that supplies the key
 * (or a placeholder, for a keyless local server).
 */
import {
  type Api,
  createModels,
  createProvider,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { KernelModels } from "../kernel/providers";

/** One provider, as a configuration file would describe it. */
export interface ProviderSpec {
  id: string;
  baseUrl: string;
  /** The key, when the endpoint wants one. A keyless server passes nothing. */
  apiKey?: string | undefined;
  /** Extra request headers, as configured (a null value drops one). */
  headers?: Record<string, string | null> | undefined;
  models: ModelSpec[];
}

export interface ModelSpec {
  id: string;
  name?: string | undefined;
  contextWindow?: number | undefined;
  maxTokens?: number | undefined;
  input?: ("text" | "image")[] | undefined;
  reasoning?: boolean | undefined;
}

const DEFAULT_CONTEXT_WINDOW = 128_000;

/** A `KernelModels` over a real provider: no fakes, no registry of builtins. */
export function realModels(spec: ProviderSpec): KernelModels {
  const headers =
    spec.headers === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(spec.headers).filter(
            (entry): entry is [string, string] => entry[1] !== null,
          ),
        );
  const models = createModels();
  models.setProvider(
    createProvider({
      id: spec.id,
      baseUrl: spec.baseUrl,
      ...(headers === undefined || Object.keys(headers).length === 0
        ? {}
        : { headers }),
      // Every provider has auth semantics, even a keyless one: the resolver
      // says what to send, and a keyless endpoint gets a placeholder.
      auth: {
        apiKey: {
          name: `${spec.id} key`,
          resolve: async () => ({
            auth: {
              apiKey:
                spec.apiKey !== undefined && spec.apiKey.length > 0
                  ? spec.apiKey
                  : "no-key",
            },
            source: "test config",
          }),
        },
      },
      models: spec.models.map((model) => toModel(spec, model)),
      api: openAICompletionsApi(),
    }),
  );
  return {
    getModel: (provider, id) => models.getModel(provider, id),
    streamSimple: (model, context, options) =>
      models.streamSimple(model, context, options),
    completeSimple: (model, context, options) =>
      models.completeSimple(model, context, options),
  };
}

function toModel(provider: ProviderSpec, model: ModelSpec): Model<Api> {
  return {
    id: model.id,
    name: model.name ?? model.id,
    api: "openai-completions",
    provider: provider.id,
    baseUrl: provider.baseUrl,
    reasoning: model.reasoning ?? false,
    input: model.input ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens:
      model.maxTokens ??
      Math.min(8_192, model.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
    // Auto-detect the protocol details from the base URL: a custom endpoint is
    // exactly the case where guessing beats configuring.
    compat: {},
  } as Model<Api>;
}
