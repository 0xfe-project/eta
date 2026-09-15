import type { ThinkingLevel } from "./types.ts";

export const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ProviderKind = "kimi-coding" | "deepseek" | "openai-codex" | "openai-compatible";

export const BUILTIN_PROVIDER_PRESETS = {
	"openai-codex": { name: "Codex", baseUrl: "https://chatgpt.com/backend-api", logo: "openai.svg" },
	"kimi-coding": { name: "Kimi for Coding", baseUrl: "https://api.kimi.com/coding/v1", logo: "kimi.svg" },
	deepseek: { name: "DeepSeek", baseUrl: "https://api.deepseek.com", logo: "deepseek.svg" },
} as const;

export function providerPreset(kind: ProviderKind) {
	return kind === "openai-compatible" ? undefined : BUILTIN_PROVIDER_PRESETS[kind];
}

/** Provider-owned capabilities. Missing metadata is unknown, not a negative claim. */
export interface ModelCapabilities {
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	input?: ("text" | "image")[];
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
	models: EtaModelConfig[];
}

export function effectiveModel(model: EtaModelConfig): EtaModelConfig {
	return { ...model, ...model.overrides };
}

export function modelThinkingLevels(input: EtaModelConfig): ThinkingLevel[] {
	const model = effectiveModel(input);
	if (model.thinkingMode === "no" || model.reasoning === false) return ["off"];
	if (model.reasoning === undefined) return [];
	const efforts = model.reasoningEfforts ?? [];
	// With no declared effort controls we leave the provider in charge. In particular,
	// an always-thinking model must not acquire an invented off switch.
	if (efforts.length === 0) return [];
	const off = model.thinkingMode === "both" && model.providerDefaultEffort !== undefined;
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
