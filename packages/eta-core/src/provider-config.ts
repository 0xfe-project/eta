import type { ThinkingLevel } from "./types.ts";

export const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ProviderKind = "kimi-coding" | "deepseek" | "zai-coding-cn" | "zai" | "openai-codex" | "openai-compatible" | "openai-responses";
export type ModelInput = "text" | "image";

export const BUILTIN_PROVIDER_PRESETS = {
	"openai-codex": { name: "Codex", baseUrl: "https://chatgpt.com/backend-api", logo: "openai.svg" },
	"kimi-coding": { name: "Kimi for Coding", baseUrl: "https://api.kimi.com/coding/v1", logo: "kimi.svg" },
	deepseek: { name: "DeepSeek", baseUrl: "https://api.deepseek.com", logo: "deepseek.svg" },
	"zai-coding-cn": { name: "GLM Coding Plan (CN)", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", logo: "zai.svg" },
	zai: { name: "GLM Coding Plan (Global)", baseUrl: "https://api.z.ai/api/coding/paas/v4", logo: "zai.svg" },
} as const;

export function providerPreset(kind: ProviderKind) {
	return isCustomKind(kind) ? undefined : BUILTIN_PROVIDER_PRESETS[kind];
}

/**
 * Kinds with no built-in endpoint: the user supplies the URL, the key and the model list.
 * Both custom kinds speak OpenAI's wire protocols and differ only in the transport they pick:
 * `openai-responses` posts to `/responses`, `openai-compatible` to `/chat/completions`.
 */
export function isCustomKind(kind: ProviderKind | undefined): kind is "openai-compatible" | "openai-responses" {
	// A config entry written before kinds existed has none, and the historical reading of that
	// is the custom Chat Completions endpoint — the same default `normalizeProvider` applies.
	return kind === undefined || kind === "openai-compatible" || kind === "openai-responses";
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

export interface EtaModelConfig extends ModelCapabilities {
	id: string;
	/** User preference; omission follows the provider default. */
	defaultThinking?: ThinkingLevel;
	/** Manual corrections for custom endpoints, retained across discovery refreshes. */
	overrides?: ModelCapabilities;
}

export interface ProviderSummary {
	id: string;
	name?: string;
	kind: ProviderKind;
	baseUrl: string;
	hasApiKey: boolean;
	headers?: ProviderHeaders;
	models: EtaModelConfig[];
	lastRefreshedAt?: string;
}

export interface NetworkConfig {
	mode: "system" | "manual" | "direct";
	proxyUrl?: string;
	noProxy?: string;
}

export interface ProvidersView {
	network?: NetworkConfig;
	providers: ProviderSummary[];
	defaultModel?: string;
	revision: string;
}

export interface ProviderInput {
	id: string;
	name?: string;
	kind: ProviderKind;
	baseUrl: string;
	/** Omitted keeps the saved key; null explicitly clears it. Never returned by GET. */
	apiKey?: string | null;
	/** Omitted keeps the saved headers; null clears them. Echoed by GET, unlike apiKey. */
	headers?: ProviderHeaders | null;
	models: EtaModelConfig[];
}

/**
 * Extra request headers for one provider. A null value means “do not send this header”,
 * which also suppresses a header the transport would add by itself (User-Agent, Authorization).
 */
export type ProviderHeaders = Record<string, string | null>;

/** RFC 7230 token: the only names worth accepting from a settings form. */
export const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
export const MAX_PROVIDER_HEADERS = 32;
export const MAX_HEADER_NAME_LENGTH = 128;
export const MAX_HEADER_VALUE_LENGTH = 8192;

/**
 * Read-path sanitising for a config file that may have been hand-edited: unusable entries are
 * dropped instead of throwing. Names collapse case-insensitively, last occurrence wins.
 */
export function sanitizeProviderHeaders(value: unknown): ProviderHeaders | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const entries: [string, string | null][] = [];
	for (const [rawName, raw] of Object.entries(value)) {
		if (entries.length >= MAX_PROVIDER_HEADERS) break;
		const name = rawName.trim();
		if (!HEADER_NAME_PATTERN.test(name) || name.length > MAX_HEADER_NAME_LENGTH) continue;
		if (raw !== null && (typeof raw !== "string" || raw.length > MAX_HEADER_VALUE_LENGTH || /[\r\n]/.test(raw))) continue;
		const header = raw === null || raw.trim().length === 0 ? null : raw.trim();
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			if (entries[index]![0].toLowerCase() === name.toLowerCase()) entries.splice(index, 1);
		}
		entries.push([name, header]);
	}
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Provider overrides applied over transport defaults, case-insensitively; null removes a header. */
export function applyProviderHeaders(base: Record<string, string>, headers?: ProviderHeaders): Record<string, string> {
	const out: Record<string, string> = { ...base };
	for (const [rawName, value] of Object.entries(headers ?? {})) {
		const name = rawName.trim();
		if (!HEADER_NAME_PATTERN.test(name)) continue;
		for (const existing of Object.keys(out)) {
			if (existing.toLowerCase() === name.toLowerCase()) delete out[existing];
		}
		if (value !== null) out[name] = value;
	}
	return out;
}

export function effectiveModel(model: EtaModelConfig): EtaModelConfig {
	return { ...model, ...model.overrides };
}

/** Undefined means the provider did not publish input capabilities. */
export function modelSupportsVision(model: ModelCapabilities): boolean | undefined {
	return model.input === undefined ? undefined : model.input.includes("image");
}

export function modelThinkingLevels(input: EtaModelConfig): ThinkingLevel[] {
	const model = effectiveModel(input);
	if (model.thinkingMode === "no" || model.reasoning === false) return ["off"];
	if (model.reasoning === undefined) return [];
	const efforts = model.reasoningEfforts ?? [];
	// With no declared effort controls we leave the provider in charge. In particular,
	// an always-thinking model must not acquire an invented off switch.
	if (efforts.length === 0) return [];
	const off = model.thinkingMode === "both";
	return [...(off ? ["off" as const] : []), ...efforts];
}

export function modelDefaultThinking(input: EtaModelConfig): ThinkingLevel {
	const model = effectiveModel(input);
	const levels = modelThinkingLevels(model);
	if (model.defaultThinking !== undefined && levels.includes(model.defaultThinking)) return model.defaultThinking;
	if (model.providerDefaultEffort !== undefined && levels.includes(model.providerDefaultEffort)) return model.providerDefaultEffort;
	// "off" is the harness's no-parameter setting. The provider adapter only translates
	// it to an explicit disable when modelThinkingLevels actually offers an off switch.
	return "off";
}

export interface CodexLoginView {
	id: string;
	status: "pending" | "complete" | "failed";
	method?: "browser" | "device_code";
	manualPromptId?: string;
	userCode?: string;
	url?: string;
}
