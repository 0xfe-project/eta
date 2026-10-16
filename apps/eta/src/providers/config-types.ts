/**
 * What a provider *is*, as data: kinds, presets, the capabilities a model declares, and the
 * header rules. Ported from eta-agent's `core/provider-config.ts`, which lived in core there
 * because the client also rendered it; here the client gets the view types over the wire and
 * this file stays server-side logic.
 *
 * The reason this is a separate file from the config store: none of it touches the filesystem.
 * It is the vocabulary (what a kind means, what a model can do) and the rules that make a
 * hand-edited config file safe to read — both worth testing without a file at all.
 */

import type { ProviderHeaders, ProviderKind } from "@eta/client-contracts";
import type { ThinkingLevel } from "@eta/core";

export const MODEL_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingLevel[];

export type ModelInput = "text" | "image";

/** Kinds with a built-in endpoint; the rest take one from the user. */
export const BUILTIN_PROVIDER_PRESETS = {
  "openai-codex": {
    name: "Codex",
    baseUrl: "https://chatgpt.com/backend-api",
    logo: "openai.svg",
  },
  "kimi-coding": {
    name: "Kimi for Coding",
    baseUrl: "https://api.kimi.com/coding/v1",
    logo: "kimi.svg",
  },
  deepseek: {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    logo: "deepseek.svg",
  },
  "zai-coding-cn": {
    name: "GLM Coding Plan (CN)",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    logo: "zai.svg",
  },
  zai: {
    name: "GLM Coding Plan (Global)",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    logo: "zai.svg",
  },
} as const;

export function providerPreset(kind: ProviderKind) {
  return isCustomKind(kind)
    ? undefined
    : BUILTIN_PROVIDER_PRESETS[kind as keyof typeof BUILTIN_PROVIDER_PRESETS];
}

/**
 * Kinds with no built-in endpoint: the user supplies the URL, the key and the model list. Both
 * custom kinds speak OpenAI's wire protocols and differ only in which one: `openai-responses`
 * posts to `/responses`, `openai-compatible` to `/chat/completions`.
 */
export function isCustomKind(kind: ProviderKind | undefined): boolean {
  // A config entry written before kinds existed has none, and the historical reading of that is
  // the custom Chat Completions endpoint — the same default the normaliser applies.
  return (
    kind === undefined ||
    kind === "openai-compatible" ||
    kind === "openai-responses"
  );
}

/** Provider-owned capabilities. Missing metadata is unknown, not a negative claim. */
export interface ModelCapabilities {
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: ModelInput[];
  reasoning?: boolean;
  thinkingMode?: "only" | "both" | "no";
  reasoningEfforts?: Exclude<ThinkingLevel, "off">[];
  providerDefaultEffort?: Exclude<ThinkingLevel, "off">;
}

/** A model as the config file holds it: capabilities plus the user's own choices. */
export interface EtaModelConfig extends ModelCapabilities {
  id: string;
  /** User preference; omission follows the provider default. */
  defaultThinking?: ThinkingLevel;
  /** Manual corrections for custom endpoints, kept across discovery refreshes. */
  overrides?: ModelCapabilities;
}

/** One provider as the config file holds it. `apiKey` never leaves the server. */
export interface EtaProviderConfig {
  id: string;
  name?: string;
  kind?: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  headers?: ProviderHeaders;
  models: EtaModelConfig[];
  lastRefreshedAt?: string;
}

export interface EtaConfig {
  /**
   * Tools that ask the user before they run (P2.6 — 审批 = ask).
   *
   * Configuration rather than a fact about a tool: the same `bash` is one user's whole point and
   * another user's thing to approve every time.
   */
  approvals?: { tools?: string[] } | undefined;
  network?: {
    mode: "system" | "manual" | "direct";
    proxyUrl?: string;
    noProxy?: string;
  };
  providers?: EtaProviderConfig[];
  /** `providerId:modelId`; the first provider's first model when absent. */
  defaultModel?: string;
}

/** RFC 7230 token: the only names worth accepting from a settings form. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^\w`|~-]+$/;
const MAX_PROVIDER_HEADERS = 32;
const MAX_HEADER_NAME_LENGTH = 128;
const MAX_HEADER_VALUE_LENGTH = 8192;

/**
 * Read-path sanitising for a config file that may have been hand-edited: unusable entries are
 * dropped instead of throwing (a typo in one header must not make the whole config unreadable).
 * Names collapse case-insensitively, last occurrence wins.
 */
export function sanitizeProviderHeaders(
  value: unknown,
): ProviderHeaders | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const entries: [string, string | null][] = [];
  for (const [rawName, raw] of Object.entries(value)) {
    if (entries.length >= MAX_PROVIDER_HEADERS) break;
    const name = rawName.trim();
    if (!HEADER_NAME_PATTERN.test(name) || name.length > MAX_HEADER_NAME_LENGTH)
      continue;
    if (
      raw !== null &&
      (typeof raw !== "string" ||
        raw.length > MAX_HEADER_VALUE_LENGTH ||
        /[\r\n]/.test(raw))
    ) {
      continue;
    }
    const header = raw === null || raw.trim().length === 0 ? null : raw.trim();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index]?.[0].toLowerCase() === name.toLowerCase())
        entries.splice(index, 1);
    }
    entries.push([name, header]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Provider overrides applied over transport defaults, case-insensitively; `null` removes a header. */
export function effectiveModel(model: EtaModelConfig): EtaModelConfig {
  return { ...model, ...model.overrides };
}

/** Undefined means the provider did not publish input capabilities. */
/**
 * The thinking levels a model declares.
 *
 * Two honest answers that look like the same thing: `["off"]` for a model that says it does not
 * reason (an off switch is the only thing left), and `[]` for a model that says nothing at all —
 * "unknown" is not "none", and a model whose provider always thinks must not acquire an invented
 * off switch.
 */
export function modelThinkingLevels(input: EtaModelConfig): ThinkingLevel[] {
  const model = effectiveModel(input);
  if (model.thinkingMode === "no" || model.reasoning === false) return ["off"];
  if (model.reasoning === undefined) return [];
  const efforts = model.reasoningEfforts ?? [];
  if (efforts.length === 0) return [];
  const off = model.thinkingMode === "both";
  return [...(off ? (["off"] as const) : []), ...efforts];
}
/** `provider:modelId`, else the first configured model. */
export function configDefaultModel(
  config: EtaConfig,
): { provider: string; modelId: string } | undefined {
  const first = (config.providers ?? []).flatMap((provider) =>
    provider.models.map((model) => ({
      provider: provider.id,
      modelId: model.id,
    })),
  )[0];
  if (config.defaultModel === undefined) return first;
  const split = config.defaultModel.indexOf(":");
  if (split <= 0) return first;
  return {
    provider: config.defaultModel.slice(0, split),
    modelId: config.defaultModel.slice(split + 1),
  };
}

/** One provider, as a client sees it: the key becomes `hasApiKey`, the headers stay. */
