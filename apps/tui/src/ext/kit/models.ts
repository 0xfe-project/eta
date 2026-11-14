// Adapted from apps/web/src/queries/providers.ts (`providerLabel`, `signsIn`, `keyMissing`,
// `modelsOf`, `gatewayModels`, `useModels`): the same rules as pure functions over the
// `providers` and `llm` targets' sections.

import type {
  LlmAccounts,
  LlmModel,
  ProviderKind,
  ProviderSummary,
  ProvidersView,
} from "@eta/client-contracts";
import type { Locale } from "../../config/types";
import { LLM_PROVIDER_ID } from "@eta/client-contracts";
import { useMemo } from "react";
import { useLocale, useMessages } from "../../i18n/react";
import { llmProblemText } from "./errors";
import { kitMessages } from "./messages";
import { useMounted, useTarget, useWireState } from "./wire-hooks";

const PROVIDERS = "providers";

/** Names of the kinds that come with an endpoint of their own. */
const PRESET_NAMES: Partial<Record<ProviderKind, string>> = {
  eta: "Eta Token Plan",
  "openai-codex": "Codex",
  "kimi-coding": "Kimi for Coding",
  deepseek: "DeepSeek",
  "zai-coding-cn": "GLM Coding Plan (CN)",
  zai: "GLM Coding Plan (Global)",
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
};

/** What a provider is called: its own name, else its kind's, else its id. */
export function providerLabel(
  provider: Pick<ProviderSummary, "id" | "kind" | "name">,
): string {
  return provider.name ?? PRESET_NAMES[provider.kind] ?? provider.id;
}

/** Codex signs in through ChatGPT instead of holding a key. */
function signsIn(provider: Pick<ProviderSummary, "kind">): boolean {
  return provider.kind === "openai-codex";
}

/**
 * Whether the provider cannot be used until a key is set. Custom endpoints may run without one,
 * and Codex has no key.
 */
export function keyMissing(
  provider: Pick<ProviderSummary, "hasApiKey" | "kind">,
): boolean {
  return (
    !provider.hasApiKey &&
    !signsIn(provider) &&
    provider.kind !== "openai-compatible" &&
    provider.kind !== "openai-responses"
  );
}

/** A model a chat can run on, as a picker lists it. */
export interface Model {
  /** `providerId:modelId`, the id an agent names; `llm:<id>` for the gateway's. */
  id: string;
  provider: string;
  providerName: string;
  name: string;
  contextWindow?: number | undefined;
  /** Not while its provider lacks a key it cannot run without, or the gateway says it is down. */
  available: boolean;
  /** The configured default model, else the first one; one model of a list that is not empty has it. */
  default: boolean;
  /** Why it cannot be used, when the gateway says, in the user's language. */
  unavailableReason?: string | undefined;
}

function configuredModels(view: ProvidersView): Model[] {
  return view.providers.flatMap((provider) => {
    const providerName = providerLabel(provider);
    const available = !keyMissing(provider);
    return provider.models.map(
      (model): Model => ({
        id: `${provider.id}:${model.id}`,
        provider: provider.id,
        providerName,
        name: model.name ?? model.id,
        contextWindow: model.contextWindow,
        available,
        default: false,
      }),
    );
  });
}

function gatewayModels(
  models: readonly LlmModel[],
  connectors: LlmAccounts["connectors"],
  locale: Locale,
): Model[] {
  const names = new Map(connectors.map((c) => [c.id, c.name]));
  return models.map((model) => ({
    id: `${LLM_PROVIDER_ID}:${model.id}`,
    provider: LLM_PROVIDER_ID,
    providerName: names.get(model.connector) ?? model.connector,
    name: model.name,
    contextWindow: model.contextWindow,
    available: model.available,
    default: false,
    unavailableReason:
      model.reason === undefined
        ? undefined
        : llmProblemText(model.reason, locale),
  }));
}

/** The sections of the `llm` target a model list reads; undefined when the gateway is not mounted. */
export interface LlmSections {
  accounts: LlmAccounts | undefined;
  models: readonly LlmModel[] | undefined;
}

/**
 * Every configured provider's models, then the gateway's, with the default marked; undefined
 * until the providers' config has come.
 */
export function buildModels(input: {
  providers: ProvidersView | undefined;
  llm: LlmSections | undefined;
  locale: Locale;
}): Model[] | undefined {
  const { providers, llm, locale } = input;
  if (providers === undefined) return undefined;
  const merged = [
    ...configuredModels(providers),
    ...gatewayModels(
      llm?.models ?? [],
      llm?.accounts?.connectors ?? [],
      locale,
    ),
  ];
  const fallback =
    merged.find((model) => model.id === providers.defaultModel) ?? merged[0];
  return merged.map((model) => ({ ...model, default: model === fallback }));
}

/** The models that can be used now, in order. */
export function usableModels(models: readonly Model[]): Model[] {
  return models.filter((model) => model.available);
}

/** The host's models, kept live; undefined until the providers' config has come. */
export function useModels(): Model[] | undefined {
  const locale = useLocale();
  const providers = useTarget(PROVIDERS)?.sections.config as
    | ProvidersView
    | undefined;
  const gateway = useMounted(LLM_PROVIDER_ID);
  const llmTarget = useTarget(
    gateway.mounted && gateway.error === undefined
      ? LLM_PROVIDER_ID
      : undefined,
  );
  const accounts = llmTarget?.sections.accounts as LlmAccounts | undefined;
  const models = llmTarget?.sections.models as LlmModel[] | undefined;
  return useMemo(
    () =>
      buildModels({
        providers,
        llm: llmTarget === undefined ? undefined : { accounts, models },
        locale,
      }),
    [providers, llmTarget, accounts, models, locale],
  );
}

/**
 * Why the providers' config will not come: the host has no providers plugin, or it failed to load
 * (its own error). Undefined before hello and while all is well. `useModels` stays undefined in
 * both cases; read this next to it to say so instead of waiting.
 */
export function useProvidersProblem(): string | undefined {
  const t = useMessages(kitMessages);
  const open = useWireState((state) => state.status === "open");
  const { mounted, error } = useMounted(PROVIDERS);
  if (!open) return undefined;
  if (!mounted) return t("providersMissing");
  return error;
}
