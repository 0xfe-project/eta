import type {
  EtaModelConfig,
  LlmConnector,
  ProviderKind,
  UnsupportedModel,
} from "@eta/client-contracts";
import { MODEL_SOURCES, modelSource } from "@eta/client-contracts";
import { WireError } from "@eta/client-contracts/wire";
import { uiText } from "../../../i18n";
import { problemText } from "../../../services/problem-text";

// What adding a model source is made of, apart from how it is drawn: the presets (the list and its order), what a new source is called and which of its models
// start ticked, and the failures in the user's words.

/** One choice of the first step: a gateway connector, or a kind the config holds. */
export type SourcePreset =
  | { id: string; group: "subscription" | "key"; connector: string }
  | {
      id: string;
      group: "recommended" | "key" | "custom";
      kind: ProviderKind;
      baseUrl: string;
      /** The address and protocol are the person's: the custom endpoint and the local server. */
      custom?: "endpoint" | "local";
    };

const LOCAL_URL = "http://127.0.0.1:11434/v1";

/** The key sources whose models come from where `models` says: makers first, then gateways. */
const keyPresets = (models: string): SourcePreset[] =>
  (Object.keys(MODEL_SOURCES) as ProviderKind[])
    .filter((kind) => {
      const source = modelSource(kind);
      return source?.auth === "key" && source.models === models;
    })
    .map((kind) => ({
      id: kind,
      // Eta's own gateway: one key, on top of every group.
      group: kind === "eta" ? "recommended" : "key",
      kind,
      baseUrl: modelSource(kind)?.baseUrl ?? "",
    }));

/** Read when drawn, so a kind added to the definition is a choice without anything else. */
export const sourcePresets = (): readonly SourcePreset[] => [
  { id: "codex", group: "subscription", connector: "codex" },
  { id: "xai", group: "subscription", connector: "xai" },
  ...keyPresets("endpoint"),
  { id: "gemini", group: "key", connector: "gemini" },
  ...keyPresets("models-dev"),
  {
    id: "custom",
    group: "custom",
    kind: "openai-compatible",
    baseUrl: "",
    custom: "endpoint",
  },
  {
    id: "local",
    group: "custom",
    kind: "openai-compatible",
    baseUrl: LOCAL_URL,
    custom: "local",
  },
];

export const SOURCE_GROUPS = ["subscription", "key", "custom"] as const;

export function presetName(
  preset: SourcePreset,
  connectors: readonly LlmConnector[],
): string {
  if ("connector" in preset)
    return (
      connectors.find((connector) => connector.id === preset.connector)?.name ??
      preset.connector
    );
  if (preset.custom === "endpoint") return uiText("addSourceCustom");
  if (preset.custom === "local") return uiText("localModels");
  return modelSource(preset.kind)?.name ?? preset.kind;
}

/** A name as an id: the provider's address in the config, and the front of its model ids. */
function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

export function uniqueId(name: string, taken: readonly string[]): string {
  const base = slug(name) || "provider";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/** What a custom endpoint is called before anyone names it: the server it is, or its host. */
export function endpointName(baseUrl: string, local: boolean): string {
  try {
    const url = new URL(baseUrl);
    if (local)
      return url.port === "11434"
        ? "Ollama"
        : url.port === "1234"
          ? "LM Studio"
          : uiText("localModels");
    return url.host.replace(/^api\./, "");
  } catch {
    return uiText("addSourceCustom");
  }
}

/**
 * The models ticked when the list arrives. A preset's list is curated by its provider, so all of
 * it that is current; a custom endpoint may list hundreds (OpenRouter), so only a short list is.
 */
export function recommended(
  models: readonly EtaModelConfig[],
  custom: boolean,
): string[] {
  const current = models.filter((model) => model.deprecated !== true);
  if (custom && current.length > 12) return [];
  return current.map((model) => model.id);
}

/** What a protocol package is called where a person reads it. */
const PROTOCOL_NAMES: Record<string, string> = {
  "@ai-sdk/anthropic": "Anthropic",
  "@ai-sdk/google": "Google",
  "@ai-sdk/google-vertex": "Google",
  "@ai-sdk/mistral": "Mistral",
};

export function unsupportedReason(model: UnsupportedModel): string {
  if (model.reason === "protocol")
    return uiText("addSourceUnsupported", {
      protocol: PROTOCOL_NAMES[model.protocol] ?? model.protocol,
    });
  return uiText(
    model.reason === "endpoint"
      ? "addSourceOtherEndpoint"
      : "addSourceIncomplete",
  );
}

export function protocolName(kind: string): string {
  return kind === "openai-responses" ? "Responses" : "Chat Completions";
}

/** A context window the way a list reads it: 128K, 1M. */
export function formatContext(tokens: number | undefined): string {
  if (tokens === undefined) return "—";
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  return `${Math.round(tokens / 1000)}K`;
}

export function abilityTags(model: EtaModelConfig): string[] {
  return [
    ...(model.reasoning === true ? [uiText("addSourceReasoning")] : []),
    ...(model.input?.includes("image") === true
      ? [uiText("addSourceImages")]
      : []),
  ];
}

/** The guidance shown with a connector's sign-in. */
export function connectorHint(id: string): string | undefined {
  if (id === "codex") return uiText("addSourceCodexHint");
  if (id === "xai") return uiText("addSourceXaiHint");
  if (id === "gemini") return uiText("addSourceGeminiHint");
  return undefined;
}

export function connectorKeyUrl(id: string): string | undefined {
  return id === "gemini" ? "https://aistudio.google.com/apikey" : undefined;
}

/** A source's own key page link text, when it names its page. */
export function keyLinkText(kind: ProviderKind): string {
  return kind === "commandcode"
    ? uiText("addSourceCommandCodeGetKey")
    : uiText("addSourceGetKey");
}

export function keyNote(kind: ProviderKind): string | undefined {
  return kind === "commandcode"
    ? uiText("addSourceCommandCodeNote")
    : undefined;
}

const PROBLEMS = {
  login_expired: "llmProblemLoginExpired",
  invalid_api_key: "llmProblemInvalidApiKey",
  login_start_failed: "llmProblemLoginStartFailed",
  login_timeout: "llmProblemLoginTimeout",
  device_code_timeout: "llmProblemDeviceCodeTimeout",
  login_failed: "llmProblemLoginFailed",
  login_save_failed: "llmProblemLoginSaveFailed",
  api_key_required: "llmProblemApiKeyRequired",
  duplicate_api_key: "llmProblemDuplicateApiKey",
  key_check_unavailable: "llmProblemKeyCheckUnavailable",
  gateway_unavailable: "llmProblemGatewayUnavailable",
} as const;

/** A gateway problem (a code and its values) in the user's language. */
export function llmProblemText(problem: {
  code: string;
  message: string;
  params?: { provider?: string | undefined } | undefined;
}): string {
  const key = PROBLEMS[problem.code as keyof typeof PROBLEMS];
  if (key === undefined)
    return uiText("llmProblemUnknown", {
      code: problem.code,
      message: problem.message,
    });
  return uiText(key, { provider: problem.params?.provider ?? "" });
}

/** Any failed call, told the way the host explains it. */
export function wireErrorText(error: unknown): string {
  if (error instanceof WireError) {
    if (error.code === "disconnected") return uiText("addSourceDisconnected");
    if (error.code === "timeout") return uiText("addSourceTimeout");
    if (error.problem !== undefined)
      return llmProblemText({
        code: error.problem.code,
        message: error.message,
        params: error.problem.params,
      });
    return error.message;
  }
  return problemText(error);
}

/** A listing's failure code (`discovery_http_404`, `discovery_network: …`) in the user's words. */
export function discoveryErrorText(error: unknown): string {
  if (
    !(error instanceof WireError) ||
    error.code === "timeout" ||
    error.code === "disconnected"
  )
    return wireErrorText(error);
  const code = error.message;
  if (/^discovery_http_(?:401|403)$/.test(code))
    return uiText("addSourceKeyRefused");
  if (code === "config_changed")
    return uiText("addSourceDiscoveryConfigChanged");
  const http = /^discovery_http_(\d{3})$/.exec(code);
  if (http) return uiText("addSourceDiscoveryHttp", { status: http[1] });
  if (code === "discovery_network")
    return uiText("addSourceDiscoveryUnreachable");
  if (code.startsWith("discovery_network: "))
    return uiText("addSourceDiscoveryNetwork", {
      reason: code.slice("discovery_network: ".length),
    });
  const codes = {
    discovery_invalid_connection: "addSourceDiscoveryInvalidConnection",
    discovery_unsupported: "addSourceDiscoveryUnsupported",
    discovery_response: "addSourceDiscoveryResponse",
    discovery_timeout: "addSourceDiscoveryTimeout",
  } as const;
  const key = codes[code as keyof typeof codes];
  return key === undefined ? wireErrorText(error) : uiText(key);
}

/** Why saving the new source failed. */
export function saveErrorText(error: unknown): string {
  if (error instanceof WireError && error.code === "server") {
    if (error.message === "config_changed")
      return uiText("addSourceSaveConfigChanged");
    if (error.message === "save_failed") return uiText("addSourceSaveFailed");
    if (error.message === "invalid_saved_config")
      return uiText("addSourceSaveInvalid");
  }
  return wireErrorText(error);
}
