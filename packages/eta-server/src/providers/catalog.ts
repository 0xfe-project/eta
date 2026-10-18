/**
 * The provider catalog: which kinds exist, what their runtime looks like, and which models each
 * publishes.
 *
 * Two sources, deliberately kept apart:
 *
 * - **The checked-in JSON** (`catalog.json`, ported from eta-agent) says, per provider kind, how
 *   to match it, how its auth and discovery work, which runtime adapter it needs, and which
 *   models it publishes with what capabilities. It is data because it is the part that changes
 *   when a provider ships a new model.
 * - **pi-ai's own provider factories** supply live capabilities (a model's real context window,
 *   whether it reasons). The JSON is checked in because a catalog that can only be known by
 *   asking the network is a catalog that cannot render offline.
 *
 * The parsing is strict on purpose: this file is the contract for what a provider *is*, and a
 * typo in it should fail loudly at load rather than produce a provider that half works.
 */
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import { zaiCodingCnProvider } from "@earendil-works/pi-ai/providers/zai-coding-cn";
import type { ProviderKind } from "@eta/client-contracts";
import rawCatalog from "./catalog.json";
import {
  BUILTIN_PROVIDER_PRESETS,
  type EtaModelConfig,
  isCustomKind,
  MODEL_THINKING_LEVELS,
  type ModelCapabilities,
  type ModelInput,
} from "./config-types";

export interface ProviderRuntimeDefinition {
  adapter: "openai-chat" | "openai-responses" | "codex";
  thinking?: "reasoning-effort" | "deepseek" | "zai";
  developerRole?: boolean;
  store?: boolean;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  replayReasoningContent?: boolean;
  toolStream?: "zai";
}

export interface ProviderCatalogEntry {
  id: string;
  match: { kinds: ProviderKind[]; baseUrls: string[] };
  auth: {
    adapter: "api-key" | "codex-oauth";
    required: boolean;
    missingError?: string;
  };
  discovery: {
    adapter: "openai-models" | "catalog";
    requireContextWindow: boolean;
  };
  runtime: ProviderRuntimeDefinition;
  /** Whether this provider only serves the models the catalog lists. */
  restrictToListedModels: boolean;
  models: Map<string, ModelCapabilities>;
}

/** A provider reference: what a config entry says about where it points. */
export interface ProviderReference {
  kind?: ProviderKind;
  baseUrl: string;
}

const PROVIDER_KINDS = new Set<string>([
  ...Object.keys(BUILTIN_PROVIDER_PRESETS),
  "openai-compatible",
  "openai-responses",
]);
const CAPABILITY_KEYS = new Set([
  "name",
  "contextWindow",
  "maxTokens",
  "input",
  "reasoning",
  "thinkingMode",
  "reasoningEfforts",
  "providerDefaultEffort",
]);
const INPUTS = new Set<ModelInput>(["text", "image"]);
const EFFORTS = new Set<string>(
  MODEL_THINKING_LEVELS.filter((level) => level !== "off"),
);

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid provider catalog: ${label}`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error(`invalid provider catalog: ${label} field`);
}

function normalizedBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("invalid provider catalog: base URL");
  }
  return url.href.replace(/\/+$/, "");
}

function stringArray(
  value: unknown,
  allowed: Set<string>,
  label: string,
  allowEmpty = false,
): string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((item) => typeof item !== "string" || !allowed.has(item))
  ) {
    throw new Error(`invalid provider catalog: ${label}`);
  }
  return [...new Set(value)];
}

function positive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid provider catalog: ${label}`);
  }
  return value;
}

function parseCapabilities(value: unknown, label: string): ModelCapabilities {
  const input = object(value, label);
  onlyKeys(input, CAPABILITY_KEYS, label);
  const output: ModelCapabilities = {};
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || input.name.trim().length === 0)
      throw new Error(`invalid provider catalog: ${label} name`);
    output.name = input.name.trim();
  }
  if (input.contextWindow !== undefined)
    output.contextWindow = positive(
      input.contextWindow,
      `${label} contextWindow`,
    );
  if (input.maxTokens !== undefined)
    output.maxTokens = positive(input.maxTokens, `${label} maxTokens`);
  if (input.input !== undefined)
    output.input = stringArray(
      input.input,
      INPUTS,
      `${label} input`,
    ) as ModelInput[];
  if (input.reasoning !== undefined) {
    if (typeof input.reasoning !== "boolean")
      throw new Error(`invalid provider catalog: ${label} reasoning`);
    output.reasoning = input.reasoning;
  }
  if (input.thinkingMode !== undefined) {
    if (
      input.thinkingMode !== "only" &&
      input.thinkingMode !== "both" &&
      input.thinkingMode !== "no"
    ) {
      throw new Error(`invalid provider catalog: ${label} thinkingMode`);
    }
    output.thinkingMode = input.thinkingMode;
  }
  if (input.reasoningEfforts !== undefined) {
    output.reasoningEfforts = stringArray(
      input.reasoningEfforts,
      EFFORTS,
      `${label} reasoningEfforts`,
      true,
    ) as NonNullable<ModelCapabilities["reasoningEfforts"]>;
  }
  if (input.providerDefaultEffort !== undefined) {
    if (
      typeof input.providerDefaultEffort !== "string" ||
      !EFFORTS.has(input.providerDefaultEffort)
    ) {
      throw new Error(
        `invalid provider catalog: ${label} providerDefaultEffort`,
      );
    }
    output.providerDefaultEffort =
      input.providerDefaultEffort as ModelCapabilities["providerDefaultEffort"];
  }
  if (
    output.contextWindow !== undefined &&
    output.maxTokens !== undefined &&
    output.maxTokens > output.contextWindow
  ) {
    throw new Error(`invalid provider catalog: ${label} token limits`);
  }
  return output;
}

function parseRuntime(
  value: unknown,
  label: string,
): ProviderRuntimeDefinition {
  const input = object(value, label);
  onlyKeys(
    input,
    new Set([
      "adapter",
      "thinking",
      "developerRole",
      "store",
      "maxTokensField",
      "replayReasoningContent",
      "toolStream",
    ]),
    label,
  );
  if (
    input.adapter !== "openai-chat" &&
    input.adapter !== "openai-responses" &&
    input.adapter !== "codex"
  ) {
    throw new Error(`invalid provider catalog: ${label} adapter`);
  }
  if (
    input.adapter !== "openai-chat" &&
    Object.keys(input).some((key) => key !== "adapter")
  ) {
    throw new Error(`invalid provider catalog: ${label} transport fields`);
  }
  const output: ProviderRuntimeDefinition = { adapter: input.adapter };
  if (input.thinking !== undefined) {
    if (
      input.thinking !== "reasoning-effort" &&
      input.thinking !== "deepseek" &&
      input.thinking !== "zai"
    ) {
      throw new Error(`invalid provider catalog: ${label} thinking`);
    }
    output.thinking = input.thinking;
  }
  for (const key of [
    "developerRole",
    "store",
    "replayReasoningContent",
  ] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "boolean")
      throw new Error(`invalid provider catalog: ${label} ${key}`);
    output[key] = input[key];
  }
  if (input.maxTokensField !== undefined) {
    if (
      input.maxTokensField !== "max_tokens" &&
      input.maxTokensField !== "max_completion_tokens"
    ) {
      throw new Error(`invalid provider catalog: ${label} maxTokensField`);
    }
    output.maxTokensField = input.maxTokensField;
  }
  if (input.toolStream !== undefined) {
    if (input.toolStream !== "zai")
      throw new Error(`invalid provider catalog: ${label} toolStream`);
    output.toolStream = input.toolStream;
  }
  return output;
}

/** Parse the checked-in catalog. Exported so a test can feed it something broken. */
export function parseProviderModelCatalog(
  value: unknown,
): Map<string, ProviderCatalogEntry> {
  const root = object(value, "root");
  onlyKeys(root, new Set(["version", "providers"]), "root");
  if (root.version !== 1) throw new Error("invalid provider catalog: version");
  if (!Array.isArray(root.providers))
    throw new Error("invalid provider catalog: providers");
  const output = new Map<string, ProviderCatalogEntry>();
  const matchedKinds = new Set<ProviderKind>();
  const matchedBaseUrls = new Set<string>();
  for (const rawProvider of root.providers) {
    const provider = object(rawProvider, "provider");
    onlyKeys(
      provider,
      new Set([
        "id",
        "match",
        "auth",
        "discovery",
        "runtime",
        "restrictToListedModels",
        "models",
      ]),
      "provider",
    );
    if (typeof provider.id !== "string" || provider.id.trim().length === 0) {
      throw new Error("invalid provider catalog: provider id");
    }
    const providerId = provider.id.trim();
    if (output.has(providerId))
      throw new Error(
        `invalid provider catalog: duplicate provider ${providerId}`,
      );
    const match = object(provider.match, `${providerId} match`);
    onlyKeys(match, new Set(["kinds", "baseUrls"]), `${providerId} match`);
    const kinds = stringArray(
      match.kinds,
      PROVIDER_KINDS,
      `${providerId} kinds`,
    ) as ProviderKind[];
    if (
      !Array.isArray(match.baseUrls) ||
      match.baseUrls.some((url) => typeof url !== "string")
    ) {
      throw new Error(`invalid provider catalog: ${providerId} baseUrls`);
    }
    const baseUrls = [
      ...new Set((match.baseUrls as string[]).map(normalizedBaseUrl)),
    ];
    if (kinds.some((kind) => matchedKinds.has(kind)))
      throw new Error(`invalid provider catalog: duplicate kind ${providerId}`);
    if (baseUrls.some((url) => matchedBaseUrls.has(url))) {
      throw new Error(
        `invalid provider catalog: duplicate base URL ${providerId}`,
      );
    }
    for (const kind of kinds) matchedKinds.add(kind);
    for (const url of baseUrls) matchedBaseUrls.add(url);
    if (typeof provider.restrictToListedModels !== "boolean") {
      throw new Error(`invalid provider catalog: ${providerId} restriction`);
    }
    if (!Array.isArray(provider.models))
      throw new Error(`invalid provider catalog: ${providerId} models`);
    const models = new Map<string, ModelCapabilities>();
    for (const rawModel of provider.models) {
      const model = object(rawModel, `${providerId} model`);
      onlyKeys(
        model,
        new Set(["id", ...CAPABILITY_KEYS]),
        `${providerId} model`,
      );
      if (typeof model.id !== "string" || model.id.trim().length === 0) {
        throw new Error(`invalid provider catalog: ${providerId} model id`);
      }
      const modelId = model.id.trim();
      if (models.has(modelId))
        throw new Error(
          `invalid provider catalog: duplicate model ${providerId}:${modelId}`,
        );
      const { id: _id, ...capabilities } = model;
      models.set(
        modelId,
        parseCapabilities(capabilities, `${providerId}:${modelId}`),
      );
    }
    const auth = object(provider.auth, `${providerId} auth`);
    onlyKeys(
      auth,
      new Set(["adapter", "required", "missingError"]),
      `${providerId} auth`,
    );
    if (auth.adapter !== "api-key" && auth.adapter !== "codex-oauth") {
      throw new Error(`invalid provider catalog: ${providerId} auth adapter`);
    }
    if (auth.adapter === "api-key" && typeof auth.required !== "boolean") {
      throw new Error(`invalid provider catalog: ${providerId} auth required`);
    }
    const discovery = object(provider.discovery, `${providerId} discovery`);
    onlyKeys(
      discovery,
      new Set(["adapter", "requireContextWindow"]),
      `${providerId} discovery`,
    );
    if (
      discovery.adapter !== "openai-models" &&
      discovery.adapter !== "catalog"
    ) {
      throw new Error(
        `invalid provider catalog: ${providerId} discovery adapter`,
      );
    }
    const runtime = parseRuntime(provider.runtime, `${providerId} runtime`);
    if (
      runtime.adapter === "codex" &&
      (auth.adapter !== "codex-oauth" || discovery.adapter !== "catalog")
    ) {
      throw new Error(`invalid provider catalog: ${providerId} codex adapters`);
    }
    if (auth.adapter === "codex-oauth" && runtime.adapter !== "codex") {
      throw new Error(`invalid provider catalog: ${providerId} oauth runtime`);
    }
    output.set(providerId, {
      id: providerId,
      match: { kinds, baseUrls },
      auth: {
        adapter: auth.adapter,
        required:
          auth.adapter === "api-key" ? (auth.required as boolean) : false,
        ...(typeof auth.missingError === "string"
          ? { missingError: auth.missingError }
          : {}),
      },
      discovery: {
        adapter: discovery.adapter,
        requireContextWindow: discovery.requireContextWindow === true,
      },
      runtime,
      restrictToListedModels: provider.restrictToListedModels,
      models,
    });
  }
  return output;
}

const CATALOG = parseProviderModelCatalog(rawCatalog);

/** pi-ai's own factories, for the live half of a model's capabilities. */
const PI_PROVIDERS: Readonly<Record<string, Provider<Api>>> = {
  "openai-codex": openaiCodexProvider(),
  "kimi-coding": kimiCodingProvider(),
  deepseek: deepseekProvider(),
  zai: zaiProvider(),
  "zai-coding-cn": zaiCodingCnProvider(),
};

export function providerDefinitionForKind(
  kind?: ProviderKind,
): ProviderCatalogEntry | undefined {
  const target = kind ?? "openai-compatible";
  for (const entry of CATALOG.values()) {
    if (entry.match.kinds.includes(target)) return entry;
  }
  return undefined;
}

/** Which catalog entry a config entry belongs to: by kind, or by the endpoint it points at. */
function catalogId(provider: ProviderReference): string | undefined {
  if (!isCustomKind(provider.kind))
    return providerDefinitionForKind(provider.kind)?.id;
  let baseUrl: string;
  try {
    baseUrl = normalizedBaseUrl(provider.baseUrl);
  } catch {
    return undefined;
  }
  for (const [id, entry] of CATALOG) {
    if (entry.match.baseUrls.includes(baseUrl)) return id;
  }
  return undefined;
}

/** A model's capabilities as pi-ai knows them. */
function fromPiModel(model: Model<Api>): EtaModelConfig {
  return {
    id: model.id,
    name: model.name,
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    ...(model.reasoning ? { reasoningEfforts: [] } : {}),
  };
}

/**
 * The models a provider serves: pi-ai's list, corrected by the checked-in metadata.
 *
 * The catalog wins where it speaks (its context windows and thinking levels are the ones the
 * server has tested), and pi-ai fills in what it knows. A restricted provider serves only what
 * the catalog lists — that is what stops a manually injected model id from becoming an alias for
 * something the provider will reject at request time.
 */
export function providerModelCatalog(
  provider: ProviderReference,
): EtaModelConfig[] {
  const id = catalogId(provider);
  if (id === undefined) return [];
  const entry = CATALOG.get(id);
  if (entry === undefined) return [];
  const piModels = new Map(
    (PI_PROVIDERS[id]?.getModels() ?? []).map((model) => [
      model.id,
      fromPiModel(model),
    ]),
  );
  const ids = entry.restrictToListedModels
    ? [...entry.models.keys()]
    : [...new Set([...piModels.keys(), ...entry.models.keys()])];
  return ids.map((modelId) => ({
    id: modelId,
    ...piModels.get(modelId),
    ...entry.models.get(modelId),
  }));
}

export function providerModelDefinition(
  provider: ProviderReference,
  modelId: string,
): EtaModelConfig | undefined {
  return providerModelCatalog(provider).find((model) => model.id === modelId);
}

export function providerCatalogRestrictsModels(
  provider: ProviderReference,
): boolean {
  if (isCustomKind(provider.kind)) return false;
  return (
    providerDefinitionForKind(provider.kind)?.restrictToListedModels === true
  );
}

/** Fill in saved entries from the catalog, and keep a restricted provider from exposing aliases. */
export function resolveConfiguredModels(
  provider: ProviderReference,
  models: EtaModelConfig[],
): EtaModelConfig[] {
  const restricted = providerCatalogRestrictsModels(provider);
  const resolved: EtaModelConfig[] = [];
  for (const model of models) {
    const known = providerModelDefinition(provider, model.id);
    if (restricted && known === undefined) continue;
    resolved.push({ ...(known ?? {}), ...model, id: model.id });
  }
  return resolved;
}

/** The catalog itself, for the providers that publish one (a settings page renders it). */
export function catalogModelsFor(
  provider: ProviderReference,
): EtaModelConfig[] {
  return providerModelCatalog(provider);
}
