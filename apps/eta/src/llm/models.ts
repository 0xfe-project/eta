/**
 * The gateway's models as one provider of the model layer.
 *
 * The gateway serves an OpenAI-compatible `/v1` on loopback, so to the model layer it is one more
 * provider, `llm`, whose models are whatever the accounts unlock right now. The provider is
 * rebuilt when the catalog changes (an account connected, a key removed); the configured
 * providers go on answering for everything that is not `llm`. Subscription credentials stay here,
 * in the primary: a daemon asks the primary to generate, and the primary calls the gateway.
 */
import type { MutableModels } from "@earendil-works/pi-ai";
import type { KernelModels } from "@eta/core";
import type { EtaModelConfig } from "@eta/server";
import type { CatalogModel } from "./gateway";
import { createModels } from "@earendil-works/pi-ai";
import { LLM_PROVIDER_ID } from "@eta/client-contracts";
import { buildProvider } from "@eta/server";

/** The effort levels a model config can name; the gateway's own words outside it are dropped. */
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** One catalog entry as the config vocabulary states a model. */
function modelConfig(model: CatalogModel): EtaModelConfig {
  const efforts = EFFORTS.filter((level) =>
    model.reasoningLevels.includes(level),
  );
  return {
    id: model.id,
    name: model.name,
    ...(model.contextWindow === undefined
      ? {}
      : { contextWindow: model.contextWindow }),
    input: model.image ? ["text", "image"] : ["text"],
    ...(efforts.length === 0
      ? {}
      : {
          reasoning: true,
          reasoningEfforts: [...efforts],
          thinkingMode: model.reasoningLevels.includes("none")
            ? "both"
            : "only",
        }),
  };
}

export class GatewayModels {
  readonly #inner: MutableModels = createModels();
  #endpoint: { baseUrl: string; key: string } | undefined;

  /** Point the provider at the running gateway. */
  attach(endpoint: { baseUrl: string; key: string }): void {
    this.#endpoint = endpoint;
  }

  /** Rebuild the `llm` provider from the catalog. Every model is listed, usable or not. */
  async update(catalog: readonly CatalogModel[]): Promise<void> {
    if (this.#endpoint === undefined) return;
    this.#inner.setProvider(
      await buildProvider({
        id: LLM_PROVIDER_ID,
        name: "LLM gateway",
        kind: "openai-compatible",
        baseUrl: this.#endpoint.baseUrl,
        apiKey: this.#endpoint.key,
        models: catalog.map(modelConfig),
      }),
    );
  }

  /** The model layer sessions use: the gateway's models, else the configured providers'. */
  readonly overlay = (base: KernelModels): KernelModels => {
    const own = this.#inner;
    return {
      getModel: (provider, id) =>
        provider === LLM_PROVIDER_ID
          ? own.getModel(provider, id)
          : base.getModel(provider, id),
      streamSimple: (model, context, options) =>
        model.provider === LLM_PROVIDER_ID
          ? own.streamSimple(model, context, options)
          : base.streamSimple(model, context, options),
      completeSimple: (model, context, options) =>
        model.provider === LLM_PROVIDER_ID
          ? own.completeSimple(model, context, options)
          : base.completeSimple(model, context, options),
    };
  };
}
