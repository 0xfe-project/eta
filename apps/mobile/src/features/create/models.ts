// The models an agent can be given: the
// `providers` target's config, and the `llm` gateway's catalog on a host that has one.

import type {
  AgentRuntimeInfo,
  LlmAccounts,
  LlmModel,
  ModelThinking,
  ProvidersView,
} from "@eta/client-contracts";
import {
  etaModelThinking,
  keyMissing,
  LLM_PROVIDER_ID,
  providerLabel,
} from "@eta/client-contracts";
import { wire } from "../../app/session";
import { useTarget } from "../../wire/target";

export interface Model {
  /** `providerId:modelId`: the id an agent names. */
  id: string;
  provider: string;
  providerName: string;
  name: string;
  /** Tokens it reads at once, when its provider says. */
  contextWindow?: number | undefined;
  /** Not while its provider lacks a key it cannot run without. */
  available: boolean;
  /** The thinking levels it declares; absent for a runtime's model (the runtime list says). */
  thinking?: ModelThinking | undefined;
}

function modelsOf(view: ProvidersView): Model[] {
  return view.providers.flatMap((provider) =>
    provider.models.map(
      (model): Model => ({
        id: `${provider.id}:${model.id}`,
        provider: provider.id,
        providerName: providerLabel(provider),
        name: model.name ?? model.id,
        contextWindow: model.contextWindow,
        available: !keyMissing(provider),
        thinking: etaModelThinking(model),
      }),
    ),
  );
}

const gatewayModels = (
  models: readonly LlmModel[],
  accounts: LlmAccounts | undefined,
): Model[] =>
  models.map((model) => ({
    id: `${LLM_PROVIDER_ID}:${model.id}`,
    provider: LLM_PROVIDER_ID,
    providerName:
      accounts?.connectors.find((connector) => connector.id === model.connector)
        ?.name ?? model.connector,
    name: model.name,
    contextWindow: model.contextWindow,
    available: model.available,
    thinking: etaModelThinking(model),
  }));

/** A runtime's models: `runtime:modelId`, under the runtime's name. */
export const runtimeModelsOf = (info: AgentRuntimeInfo): Model[] =>
  info.models.map((model) => ({
    id: `${info.id}:${model.id}`,
    provider: info.id,
    providerName: info.label,
    name: model.name,
    available: info.status === "available",
  }));

/**
 * Every model of the providers and the gateway, for as long as the calling component lives.
 * Undefined until the config arrives, null when this host has no `providers` to read.
 */
export function useModels(): () => Model[] | null | undefined {
  const providers = useTarget("providers");
  const llm = wire().isMounted("llm") ? useTarget("llm") : undefined;
  return () => {
    if (providers.missing()) return null;
    const config = providers.section<ProvidersView>("config");
    if (config === undefined) return undefined;
    return [
      ...modelsOf(config),
      ...gatewayModels(
        llm?.section<LlmModel[]>("models") ?? [],
        llm?.section<LlmAccounts>("accounts"),
      ),
    ];
  };
}
