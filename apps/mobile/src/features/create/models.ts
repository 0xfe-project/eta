// The models an agent can be given, read the way apps/web/src/queries/providers.ts reads them: the
// `providers` target's config, and the `llm` gateway's catalog on a host that has one.

import type {
  AgentRuntimeInfo,
  LlmAccounts,
  LlmModel,
  ProviderSummary,
  ProvidersView,
} from "@eta/client-contracts";
import { LLM_PROVIDER_ID } from "@eta/client-contracts";
import { wire } from "../../app/session";
import { useTarget } from "../../wire/target";

export interface Model {
  /** `providerId:modelId`: the id an agent names. */
  id: string;
  provider: string;
  providerName: string;
  name: string;
  /** Not while its provider lacks a key it cannot run without. */
  available: boolean;
  /** The configured default, else the first one. */
  default: boolean;
}

const PRESET_NAMES: Partial<Record<ProviderSummary["kind"], string>> = {
  "openai-codex": "Codex",
  "kimi-coding": "Kimi for Coding",
  deepseek: "DeepSeek",
  "zai-coding-cn": "GLM Coding Plan (CN)",
  zai: "GLM Coding Plan (Global)",
};

const providerLabel = (provider: ProviderSummary): string =>
  provider.name ?? PRESET_NAMES[provider.kind] ?? provider.id;

/** Custom endpoints may run without a key, and Codex signs in instead of holding one. */
const keyMissing = (provider: ProviderSummary): boolean =>
  !provider.hasApiKey &&
  provider.kind !== "openai-codex" &&
  provider.kind !== "openai-compatible" &&
  provider.kind !== "openai-responses";

function modelsOf(view: ProvidersView): Model[] {
  return view.providers.flatMap((provider) =>
    provider.models.map(
      (model): Model => ({
        id: `${provider.id}:${model.id}`,
        provider: provider.id,
        providerName: providerLabel(provider),
        name: model.name ?? model.id,
        available: !keyMissing(provider),
        default: false,
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
    available: model.available,
    default: false,
  }));

/** A runtime's models: `runtime:modelId`, under the runtime's name. */
export const runtimeModelsOf = (info: AgentRuntimeInfo): Model[] =>
  info.models.map((model) => ({
    id: `${info.id}:${model.id}`,
    provider: info.id,
    providerName: info.label,
    name: model.name,
    available: info.status === "available",
    default: model.default,
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
    const merged = [
      ...modelsOf(config),
      ...gatewayModels(
        llm?.section<LlmModel[]>("models") ?? [],
        llm?.section<LlmAccounts>("accounts"),
      ),
    ];
    const fallback =
      merged.find((model) => model.id === config.defaultModel) ?? merged[0];
    return merged.map((model) => ({ ...model, default: model === fallback }));
  };
}
