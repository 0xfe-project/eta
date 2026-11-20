/**
 * Every kind of model source eta knows, in one place: what it is called, where it is, how it is
 * signed into, where its model list comes from, and what its transport needs. The server builds
 * and discovers from this, and every client names sources and offers them from it, so a new
 * source is one entry here (plus, optionally, locale text for its key link or a note).
 */
import type { ModelApi, ModelCapabilities, ProviderSummary } from "./types";

/** One kind of model source. */
export interface ModelSource {
  /** Its name; a custom endpoint is named by the person. */
  name?: string;
  /** Its fixed endpoint. None: the person brings one (a custom endpoint). */
  baseUrl?: string;
  /** Its logo's models.dev id, when its address is not in models.dev. */
  logo?: string;
  /** Where a key is made, linked from the add-source dialog. */
  keysUrl?: string;
  /** `key`: unusable without one; `optional`: an endpoint that may be open; `sign-in`: a login. */
  auth: "key" | "optional" | "sign-in";
  /**
   * Where its model list comes from: its endpoint's `/models`, the `listed` models below, or its
   * models.dev entry (`modelsDev`), where each model also says which protocol it is served over.
   */
  models: "endpoint" | "listed" | "models-dev";
  /**
   * Its models.dev entry: names and limits for the models its official endpoint lists, or the
   * list itself with `models: "models-dev"`. `by-model-id`: a gateway of other makers' models,
   * looked up by model id across all of models.dev.
   */
  modelsDev?: string;
  /** A model its `/models` lists without a context window is not offered. */
  requireContextWindow?: true;
  /**
   * pi-ai's provider of the same id. `catalog`: pi-ai fills in the listed models' capabilities and
   * recognises the address itself; `gateway`: pi-ai says each model's wire settings.
   */
  pi?: "catalog" | "gateway";
  /** Its protocol; Chat Completions when absent. */
  api?: ModelApi;
  /** The Chat Completions fields it does not take, as pi-ai's `compat`. */
  compat?: {
    supportsDeveloperRole?: false;
    supportsStore?: false;
    maxTokensField?: "max_tokens";
  };
  /** Its models have no thinking off switch (GLM). */
  noThinkingOff?: true;
  /** The header it routes one conversation by, filled with the session's id. */
  sessionHeader?: string;
  /** The models it publishes, with what eta has tested them to do. */
  listed?: readonly ({ id: string } & ModelCapabilities)[];
}

const GATEWAY_COMPAT: ModelSource["compat"] = {
  supportsDeveloperRole: false,
  supportsStore: false,
  maxTokensField: "max_tokens",
};

const GLM: ModelSource["listed"] = [
  {
    id: "glm-5.3",
    input: ["text"],
    reasoning: true,
    thinkingMode: "both",
    reasoningEfforts: ["low", "high", "max"],
  },
  {
    id: "glm-5.3-flash",
    input: ["text", "image"],
    reasoning: true,
    thinkingMode: "both",
    reasoningEfforts: ["low", "high", "max"],
  },
];

const KIMI_EFFORTS: ModelCapabilities = {
  input: ["text", "image"],
  reasoning: true,
  thinkingMode: "only",
  reasoningEfforts: ["low", "high", "max"],
  providerDefaultEffort: "max",
};

const DEEPSEEK: ModelCapabilities = {
  contextWindow: 1_000_000,
  maxTokens: 131_072,
  reasoning: true,
  thinkingMode: "both",
  reasoningEfforts: ["low", "high", "max"],
  providerDefaultEffort: "high",
};

export const MODEL_SOURCES = {
  // Eta's own gateway: one key for other makers' models (`claude-sonnet-5`), so their facts are
  // found by model id.
  eta: {
    name: "Eta Token Plan",
    baseUrl: "https://eta.0xfe.tech/v1",
    keysUrl: "https://eta.0xfe.tech/app/dashboard?tab=keys",
    auth: "key",
    models: "endpoint",
    modelsDev: "by-model-id",
    compat: GATEWAY_COMPAT,
  },
  "openai-codex": {
    name: "Codex",
    baseUrl: "https://chatgpt.com/backend-api",
    logo: "openai",
    auth: "sign-in",
    models: "listed",
    pi: "catalog",
    listed: [
      { id: "gpt-5.3-codex-spark" },
      { id: "gpt-5.4" },
      { id: "gpt-5.4-mini" },
      { id: "gpt-5.5" },
      { id: "gpt-5.6-luna" },
      { id: "gpt-5.6-sol" },
      { id: "gpt-5.6-terra" },
      { id: "gpt-6-astra" },
    ],
  },
  deepseek: {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    auth: "key",
    models: "endpoint",
    modelsDev: "deepseek",
    pi: "catalog",
    listed: [
      {
        id: "deepseek-flash",
        name: "DeepSeek Flash",
        input: ["text", "image"],
        ...DEEPSEEK,
      },
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        input: ["text"],
        ...DEEPSEEK,
      },
    ],
  },
  "moonshot-cn": {
    name: "Moonshot (China)",
    baseUrl: "https://api.moonshot.cn/v1",
    auth: "key",
    models: "endpoint",
  },
  "moonshot-global": {
    name: "Moonshot (International)",
    baseUrl: "https://api.moonshot.ai/v1",
    auth: "key",
    models: "endpoint",
  },
  openrouter: {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: "key",
    models: "endpoint",
  },
  "kimi-coding": {
    name: "Kimi for Coding",
    baseUrl: "https://api.kimi.com/coding/v1",
    auth: "key",
    models: "endpoint",
    modelsDev: "kimi-code-plan-cn",
    requireContextWindow: true,
    pi: "catalog",
    listed: [
      {
        id: "kimi-for-coding",
        name: "K2.8 Preview",
        contextWindow: 1_048_576,
        maxTokens: 32_768,
        ...KIMI_EFFORTS,
      },
      {
        id: "kimi-for-coding-highspeed",
        name: "K2.7 Code Highspeed",
        contextWindow: 262_144,
        maxTokens: 32_768,
        input: ["text", "image"],
        reasoning: true,
        thinkingMode: "only",
        reasoningEfforts: [],
      },
      {
        id: "k3",
        name: "K3",
        contextWindow: 1_048_576,
        maxTokens: 131_072,
        ...KIMI_EFFORTS,
      },
      {
        id: "k3-256k",
        name: "K3-256k",
        contextWindow: 262_144,
        maxTokens: 131_072,
        ...KIMI_EFFORTS,
      },
    ],
  },
  "zai-coding-cn": {
    name: "GLM Coding Plan (CN)",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    auth: "key",
    models: "endpoint",
    modelsDev: "zhipuai-coding-plan",
    pi: "catalog",
    noThinkingOff: true,
    listed: GLM,
  },
  zai: {
    name: "GLM Coding Plan (Global)",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    auth: "key",
    models: "endpoint",
    modelsDev: "zai-coding-plan",
    pi: "catalog",
    noThinkingOff: true,
    listed: GLM,
  },
  // OpenCode's gateways serve several protocols; the base URL is the OpenAI one (Chat
  // Completions and Responses), and each model says which of the two it speaks. A model pi-ai
  // does not know yet gets the gateway's common settings.
  opencode: {
    name: "OpenCode Zen",
    baseUrl: "https://opencode.ai/inference/openai/v1",
    auth: "key",
    models: "models-dev",
    modelsDev: "opencode",
    pi: "gateway",
    compat: GATEWAY_COMPAT,
    sessionHeader: "x-opencode-session",
  },
  "opencode-go": {
    name: "OpenCode Go",
    baseUrl: "https://opencode.ai/inference/go/openai/v1",
    auth: "key",
    models: "models-dev",
    modelsDev: "opencode-go",
    pi: "gateway",
    compat: GATEWAY_COMPAT,
    sessionHeader: "x-opencode-session",
  },
  // Command Code's provider API: Chat Completions, Responses and Anthropic Messages behind one
  // key. eta speaks the first two; its Claude models (Messages only) are listed as unsupported.
  commandcode: {
    name: "Command Code",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    keysUrl: "https://commandcode.ai/settings/keys",
    auth: "key",
    models: "models-dev",
    modelsDev: "commandcode",
    compat: GATEWAY_COMPAT,
  },
  // Endpoints of the person's own, over Chat Completions or Responses.
  "openai-compatible": { auth: "optional", models: "endpoint" },
  "openai-responses": {
    auth: "optional",
    models: "endpoint",
    api: "openai-responses",
  },
} satisfies Record<string, ModelSource>;

/** A kind of model source. */
export type ProviderKind = keyof typeof MODEL_SOURCES;

/** The definition of a kind; a config entry with no kind is the custom Chat Completions one. */
export function modelSource(kind: string | undefined): ModelSource | undefined {
  const key = kind ?? "openai-compatible";
  return Object.hasOwn(MODEL_SOURCES, key)
    ? MODEL_SOURCES[key as ProviderKind]
    : undefined;
}

/** Kinds pointed at an endpoint of one's own: the address and the protocol are the person's. */
export function isCustomKind(kind: ProviderKind | undefined): boolean {
  const source = modelSource(kind);
  return source !== undefined && source.baseUrl === undefined;
}

/** A source signed into with an account (Codex) rather than a key. */
export function signsIn(provider: Pick<ProviderSummary, "kind">): boolean {
  return modelSource(provider.kind)?.auth === "sign-in";
}

/** Whether the provider cannot be used until a key is set. */
export function keyMissing(
  provider: Pick<ProviderSummary, "hasApiKey" | "kind">,
): boolean {
  return (
    !provider.hasApiKey && (modelSource(provider.kind)?.auth ?? "key") === "key"
  );
}

/** What a provider is called: its own name, else its kind's, else its id. */
export function providerLabel(
  provider: Pick<ProviderSummary, "id" | "kind" | "name">,
): string {
  return provider.name ?? modelSource(provider.kind)?.name ?? provider.id;
}
