import type {
  AgentView,
  EtaModelConfig,
  LlmModel,
  ProviderArgs,
  ProviderInput,
  ProviderSummary,
  ProvidersView,
} from "@eta/client-contracts";
import {
  BUILTIN_PROVIDER_PRESETS,
  LLM_PROVIDER_ID,
} from "@eta/client-contracts";
import { useMutation } from "@tanstack/react-query";
import { useMemo } from "react";
import { translate } from "@/lib/i18n";
import { llmProblemText } from "@/lib/llm-problem";
import { getWire, WireError } from "@/lib/wire";
import { NEEDS_ACTION, useLlm } from "@/queries/llm";
import {
  useTarget,
  useWireMutation,
  useWireState,
  wireErrorMessage,
} from "@/queries/wire";

// Model providers on the wire: the `providers` target, whose `config` section is the config file
// as a settings page draws it (keys become booleans, never the secret) together with the revision
// it was read at. Every write carries the revision it read; the host refuses one made on a stale
// config (`config_changed`), and the page re-reads and says so.

const TARGET = "providers";

/** What a provider is called: its own name, else its kind's, else its id. */
export function providerLabel(
  provider: Pick<ProviderSummary, "id" | "kind" | "name">,
): string {
  const preset = Object.entries(BUILTIN_PROVIDER_PRESETS).find(
    ([kind]) => kind === provider.kind,
  )?.[1];
  return provider.name ?? preset?.name ?? provider.id;
}

/** Codex signs in through ChatGPT instead of holding a key. */
export function signsIn(provider: Pick<ProviderSummary, "kind">): boolean {
  return provider.kind === "openai-codex";
}

/**
 * Whether the provider cannot be used until a key is set. Custom endpoints may run without one,
 * and Codex has no key: for it the view carries no sign-in fact, so nothing is claimed.
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

/**
 * The configured providers and the revision to write against. `error` is set when the host has no
 * working `providers` plugin: the page then says so instead of waiting for state that will not come.
 */
export function useProviders(): {
  data: ProvidersView | undefined;
  error: Error | undefined;
} {
  const data = useTarget(TARGET)?.sections.config as ProvidersView | undefined;
  const failure = useWireState((state) => {
    if (state.status !== "open") return undefined;
    const plugin = state.mounted.find((entry) => entry.name === TARGET);
    return plugin === undefined || plugin.error !== undefined
      ? (plugin?.error ?? translate("providers:errors.unavailable"))
      : undefined;
  });
  return {
    data,
    error: failure === undefined ? undefined : new Error(failure),
  };
}

/** A model a chat can run on, as a picker lists it. */
export interface Model {
  /** `providerId:modelId`: the id an agent names. */
  id: string;
  /** The provider's id, and its name for display. */
  provider: string;
  providerName: string;
  name: string;
  contextWindow?: number | undefined;
  /** Whether chats may use it: not while its provider lacks a key it cannot run without. */
  available: boolean;
  /** The model a new chat starts on: the configured default, else the first one. */
  default: boolean;
  /** Why it cannot be used, when the gateway says (an expired login, an exhausted quota). */
  unavailableReason?: string | undefined;
}

export function modelsOf(view: ProvidersView): Model[] {
  const models = view.providers.flatMap((provider) => {
    const providerName = providerLabel(provider);
    const missing = keyMissing(provider);
    return provider.models.map(
      (model): Model => ({
        id: `${provider.id}:${model.id}`,
        provider: provider.id,
        providerName,
        name: model.name ?? model.id,
        contextWindow: model.contextWindow,
        available: !missing,
        default: false,
      }),
    );
  });
  const fallback =
    models.find((model) => model.id === view.defaultModel) ?? models[0];
  return models.map((model) => ({ ...model, default: model === fallback }));
}

/**
 * The models under their provider, one group each, in the order the config lists them. A flat
 * list answers "which model" but never "from where", and the same name can come from two places.
 */
export function modelGroups(
  models: readonly Model[],
): { provider: string; label: string; models: Model[] }[] {
  const groups: { provider: string; label: string; models: Model[] }[] = [];
  for (const model of models) {
    // The gateway's models share a provider id but not a name (Codex, Grok, Gemini).
    const group = groups.find(
      (entry) =>
        entry.provider === model.provider && entry.label === model.providerName,
    );
    if (group) group.models.push(model);
    else
      groups.push({
        provider: model.provider,
        label: model.providerName,
        models: [model],
      });
  }
  return groups;
}

/**
 * The gateway's models as the picker lists them, under the name of the connector that serves
 * each (Codex, Grok, Gemini). `llm:<id>` is the id an agent names.
 */
export function gatewayModels(
  models: readonly LlmModel[],
  connectorNames: ReadonlyMap<string, string>,
): Model[] {
  return models.map((model) => ({
    id: `${LLM_PROVIDER_ID}:${model.id}`,
    provider: LLM_PROVIDER_ID,
    providerName: connectorNames.get(model.connector) ?? model.connector,
    name: model.name,
    contextWindow: model.contextWindow,
    available: model.available,
    default: false,
    unavailableReason:
      model.reason === undefined ? undefined : llmProblemText(model.reason),
  }));
}

/**
 * Every model of every configured provider and of the gateway's accounts; undefined until the
 * config has been read.
 */
export function useModels(): { data: Model[] | undefined; isError: boolean } {
  const { data, error } = useProviders();
  const llm = useLlm();
  const models = useMemo(() => {
    if (!data) return undefined;
    const configured = modelsOf(data);
    if (llm.models.length === 0) return configured;
    const names = new Map(
      llm.connectors.map((connector) => [connector.id, connector.name]),
    );
    const merged = [...configured, ...gatewayModels(llm.models, names)];
    // The default is the configured one, else the first model there is.
    const fallback =
      merged.find((model) => model.id === data.defaultModel) ?? merged[0];
    return merged.map((model) => ({ ...model, default: model === fallback }));
  }, [data, llm.models, llm.connectors]);
  return { data: models, isError: error !== undefined };
}

/** Whether a provider is missing a key it needs: what the settings button's dot marks. */
export function useNeedsAttention(): boolean {
  const { data } = useProviders();
  const { connections } = useLlm();
  return (
    (data?.providers ?? []).some(keyMissing) ||
    connections.some((connection) => NEEDS_ACTION.has(connection.state))
  );
}

export type ModelAvailability =
  | { state: "ok"; model: Model | undefined }
  | { state: "not_set" }
  | { state: "unavailable"; model: Model | undefined; message: string };

/**
 * Whether an agent can chat with its model. The host enforces the same rule; this only keeps the
 * UI ahead of it. While the config cannot be read (stale is true), the last one only names models:
 * it does not block, and the host decides on send.
 */
export function modelAvailability(
  agent: Pick<AgentView, "model"> | undefined,
  models: Model[] | undefined,
  stale = false,
): ModelAvailability {
  const model = models?.find((item) => item.id === agent?.model);
  if (!agent?.model) return { state: "not_set" };
  // Unknown until the config loads; the host still checks on send.
  if (!models || stale) return { state: "ok", model };
  if (!model) {
    return {
      state: "unavailable",
      model,
      message: translate("agents:models.errors.deleted", {
        modelName: agent.model,
      }),
    };
  }
  if (!model.available) {
    // A provider that needs a key and has none, or an account the gateway says is down.
    return {
      state: "unavailable",
      model,
      message: translate("agents:models.errors.unavailable", {
        modelName: model.name,
        reason:
          model.unavailableReason ??
          translate("providers:models.keyMissing", {
            providerName: model.providerName,
          }),
      }),
    };
  }
  return { state: "ok", model };
}

export function useModelAvailability(
  agent: Pick<AgentView, "model"> | undefined,
) {
  const { data, isError } = useModels();
  return modelAvailability(agent, data, isError);
}

// ---------------------------------------------------------------------------------- writes

/** The codes the host refuses a provider write with, and the text that tells them to the user. */
const ERROR_TEXT = {
  config_changed: "configChanged",
  models_required: "modelsRequired",
  invalid_provider_id: "invalidProviderId",
  invalid_config: "invalidConfig",
  invalid_default_model: "invalidDefaultModel",
  invalid_network: "invalidNetwork",
  invalid_saved_config: "invalidSavedConfig",
  read_failed: "readFailed",
  save_failed: "saveFailed",
} as const;

export function providerErrorMessage(error: unknown): string {
  if (
    error instanceof WireError &&
    error.code === "server" &&
    Object.hasOwn(ERROR_TEXT, error.message)
  ) {
    const text = ERROR_TEXT[error.message as keyof typeof ERROR_TEXT];
    return translate(`providers:errors.${text}`);
  }
  return wireErrorMessage(error);
}

/** Whether the host refused a write because the config moved under it. */
export function isConfigChanged(error: unknown): boolean {
  return error instanceof WireError && error.message === "config_changed";
}

/** The revision of the config the page holds. */
export function currentRevision(): string {
  const config = getWire().store.getState().targets[TARGET]?.sections.config as
    | ProvidersView
    | undefined;
  return config?.revision ?? "";
}

/**
 * A write at a revision: the one the caller read, else the newest the page holds. When the host
 * refuses because the config changed, it is asked to re-read it before the refusal is passed on,
 * so the revision the page holds afterwards is the one to write against.
 */
async function write<A extends "delete" | "save">(
  action: A,
  args: Omit<ProviderArgs[A], "revision">,
  revision: string = currentRevision(),
): Promise<{ revision: string }> {
  try {
    return await getWire().call<{ revision: string }>(TARGET, action, {
      ...args,
      revision,
    });
  } catch (error) {
    if (isConfigChanged(error)) {
      await getWire()
        .call(TARGET, "reload")
        .catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Add or replace one provider. A key left out keeps the saved one and `null` clears it. The host
 * writes the config file and builds its model layer from it at start, so a change reaches chats
 * on the next start.
 */
export function useSaveProvider() {
  return useMutation({
    mutationKey: ["wire", TARGET, "save"],
    mutationFn: (input: { provider: ProviderInput; revision?: string }) =>
      write("save", { provider: input.provider }, input.revision),
  });
}

export function useDeleteProvider() {
  return useMutation({
    mutationKey: ["wire", TARGET, "delete"],
    mutationFn: (id: string) => write("delete", { id }),
  });
}

/** Ask the provider's own endpoint which models it serves, and keep the answer. */
export function useRefreshProvider() {
  return useWireMutation<
    ProviderArgs["refresh"],
    { revision: string; models: number }
  >(TARGET, "refresh", { timeoutMs: 60_000 });
}

/** Preview only: unlike refresh, this must not write configuration or expose raw failures. */
export function discoverProviderModels(input: ProviderArgs["discover"]) {
  return getWire().call<{ models: EtaModelConfig[] }>(
    TARGET,
    "discover",
    input,
    { timeoutMs: 60_000 },
  );
}

export function discoveryErrorMessage(error: unknown): string {
  if (error instanceof WireError) {
    if (error.code === "timeout" || error.code === "disconnected")
      return wireErrorMessage(error);
    if (error.message === "config_changed")
      return translate("providers:discovery.configChanged");
    const http = /^discovery_http_(\d{3})$/.exec(error.message);
    if (http) return translate("providers:discovery.http", { status: http[1] });
    if (error.message.startsWith("discovery_network: "))
      return translate("providers:discovery.network", {
        reason: error.message.slice("discovery_network: ".length),
      });
    const codes = {
      discovery_invalid_connection: "invalidConnection",
      discovery_unsupported: "unsupported",
      discovery_response: "response",
      discovery_timeout: "timeout",
    } as const;
    if (Object.hasOwn(codes, error.message))
      return translate(
        `providers:discovery.${codes[error.message as keyof typeof codes]}`,
      );
  }
  return wireErrorMessage(error);
}
