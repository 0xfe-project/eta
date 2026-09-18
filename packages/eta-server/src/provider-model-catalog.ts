import { getSupportedThinkingLevels, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import { zaiCodingCnProvider } from "@earendil-works/pi-ai/providers/zai-coding-cn";
import {
	BUILTIN_PROVIDER_PRESETS, MODEL_THINKING_LEVELS, isCustomKind,
	type EtaModelConfig, type ModelCapabilities, type ModelInput, type ProviderKind,
} from "@eta/core/provider-config";
import rawCatalog from "./provider-model-catalog.json";

interface ProviderMatch {
	kinds: ProviderKind[];
	baseUrls: string[];
}

export interface ProviderAuthDefinition {
	adapter: "api-key" | "codex-oauth";
	required: boolean;
	missingError?: string;
}

export interface ProviderDiscoveryDefinition {
	adapter: "openai-models" | "catalog";
	requireContextWindow: boolean;
}

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
	match: ProviderMatch;
	auth: ProviderAuthDefinition;
	discovery: ProviderDiscoveryDefinition;
	runtime: ProviderRuntimeDefinition;
	restrictToListedModels: boolean;
	models: Map<string, ModelCapabilities>;
}

interface ProviderReference {
	kind?: ProviderKind;
	baseUrl: string;
}

const PROVIDER_KINDS = new Set<string>([
	...Object.keys(BUILTIN_PROVIDER_PRESETS),
	"openai-compatible",
	"openai-responses",
]);
const CAPABILITY_KEYS = new Set([
	"name", "contextWindow", "maxTokens", "input", "reasoning", "thinkingMode", "reasoningEfforts", "providerDefaultEffort",
]);
const INPUTS = new Set<ModelInput>(["text", "image"]);
const EFFORTS = new Set<string>(MODEL_THINKING_LEVELS.filter(level => level !== "off"));

function object(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Invalid provider model catalog: ${label}`);
	return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
	if (Object.keys(value).some(key => !allowed.has(key))) throw new Error(`Invalid provider model catalog: ${label} field`);
}

function normalizedBaseUrl(value: string): string {
	const url = new URL(value);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid provider model catalog: base URL");
	return url.href.replace(/\/+$/, "");
}

function stringArray(value: unknown, allowed: Set<string>, label: string, allowEmpty = false): string[] {
	if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some(item => typeof item !== "string" || !allowed.has(item))) throw new Error(`Invalid provider model catalog: ${label}`);
	return [...new Set(value)];
}

function positive(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid provider model catalog: ${label}`);
	return value;
}

function parseCapabilities(value: unknown, label: string): ModelCapabilities {
	const input = object(value, label);
	keys(input, CAPABILITY_KEYS, label);
	const output: ModelCapabilities = {};
	if (input.name !== undefined) {
		if (typeof input.name !== "string" || input.name.trim().length === 0) throw new Error(`Invalid provider model catalog: ${label} name`);
		output.name = input.name.trim();
	}
	if (input.contextWindow !== undefined) output.contextWindow = positive(input.contextWindow, `${label} contextWindow`);
	if (input.maxTokens !== undefined) output.maxTokens = positive(input.maxTokens, `${label} maxTokens`);
	if (input.input !== undefined) output.input = stringArray(input.input, INPUTS, `${label} input`) as ModelInput[];
	if (input.reasoning !== undefined) {
		if (typeof input.reasoning !== "boolean") throw new Error(`Invalid provider model catalog: ${label} reasoning`);
		output.reasoning = input.reasoning;
	}
	if (input.thinkingMode !== undefined) {
		if (input.thinkingMode !== "only" && input.thinkingMode !== "both" && input.thinkingMode !== "no") throw new Error(`Invalid provider model catalog: ${label} thinkingMode`);
		output.thinkingMode = input.thinkingMode;
	}
	if (input.reasoningEfforts !== undefined) output.reasoningEfforts = stringArray(input.reasoningEfforts, EFFORTS, `${label} reasoningEfforts`, true) as NonNullable<ModelCapabilities["reasoningEfforts"]>;
	if (input.providerDefaultEffort !== undefined) {
		if (typeof input.providerDefaultEffort !== "string" || !EFFORTS.has(input.providerDefaultEffort)) throw new Error(`Invalid provider model catalog: ${label} providerDefaultEffort`);
		output.providerDefaultEffort = input.providerDefaultEffort as ModelCapabilities["providerDefaultEffort"];
	}
	if (output.contextWindow !== undefined && output.maxTokens !== undefined && output.maxTokens > output.contextWindow) throw new Error(`Invalid provider model catalog: ${label} token limits`);
	return output;
}

function parseAuth(value: unknown, label: string): ProviderAuthDefinition {
	const input = object(value, label);
	keys(input, new Set(["adapter", "required", "missingError"]), label);
	if (input.adapter !== "api-key" && input.adapter !== "codex-oauth") throw new Error(`Invalid provider model catalog: ${label} adapter`);
	if (input.adapter === "codex-oauth") {
		if (input.required !== undefined || input.missingError !== undefined) throw new Error(`Invalid provider model catalog: ${label} oauth fields`);
		return { adapter: "codex-oauth", required: false };
	}
	if (typeof input.required !== "boolean") throw new Error(`Invalid provider model catalog: ${label} required`);
	if (input.missingError !== undefined && (typeof input.missingError !== "string" || input.missingError.trim().length === 0)) throw new Error(`Invalid provider model catalog: ${label} missingError`);
	return { adapter: "api-key", required: input.required, ...(typeof input.missingError === "string" ? { missingError: input.missingError.trim() } : {}) };
}

function parseDiscovery(value: unknown, label: string): ProviderDiscoveryDefinition {
	const input = object(value, label);
	keys(input, new Set(["adapter", "requireContextWindow"]), label);
	if (input.adapter !== "openai-models" && input.adapter !== "catalog") throw new Error(`Invalid provider model catalog: ${label} adapter`);
	if (input.requireContextWindow !== undefined && typeof input.requireContextWindow !== "boolean") throw new Error(`Invalid provider model catalog: ${label} requireContextWindow`);
	if (input.adapter === "catalog" && input.requireContextWindow !== undefined) throw new Error(`Invalid provider model catalog: ${label} catalog fields`);
	return { adapter: input.adapter, requireContextWindow: input.requireContextWindow === true };
}

function parseRuntime(value: unknown, label: string): ProviderRuntimeDefinition {
	const input = object(value, label);
	keys(input, new Set(["adapter", "thinking", "developerRole", "store", "maxTokensField", "replayReasoningContent", "toolStream"]), label);
	if (input.adapter !== "openai-chat" && input.adapter !== "openai-responses" && input.adapter !== "codex") throw new Error(`Invalid provider model catalog: ${label} adapter`);
	if (input.adapter !== "openai-chat" && Object.keys(input).some(key => key !== "adapter")) throw new Error(`Invalid provider model catalog: ${label} transport fields`);
	const output: ProviderRuntimeDefinition = { adapter: input.adapter };
	if (input.thinking !== undefined) {
		if (input.thinking !== "reasoning-effort" && input.thinking !== "deepseek" && input.thinking !== "zai") throw new Error(`Invalid provider model catalog: ${label} thinking`);
		output.thinking = input.thinking;
	}
	for (const key of ["developerRole", "store", "replayReasoningContent"] as const) {
		if (input[key] !== undefined) {
			if (typeof input[key] !== "boolean") throw new Error(`Invalid provider model catalog: ${label} ${key}`);
			output[key] = input[key];
		}
	}
	if (input.maxTokensField !== undefined) {
		if (input.maxTokensField !== "max_tokens" && input.maxTokensField !== "max_completion_tokens") throw new Error(`Invalid provider model catalog: ${label} maxTokensField`);
		output.maxTokensField = input.maxTokensField;
	}
	if (input.toolStream !== undefined) {
		if (input.toolStream !== "zai") throw new Error(`Invalid provider model catalog: ${label} toolStream`);
		output.toolStream = input.toolStream;
	}
	return output;
}

export function parseProviderModelCatalog(value: unknown): Map<string, ProviderCatalogEntry> {
	const root = object(value, "root");
	keys(root, new Set(["version", "providers"]), "root");
	if (root.version !== 1) throw new Error("Invalid provider model catalog: version");
	if (!Array.isArray(root.providers)) throw new Error("Invalid provider model catalog: providers");
	const output = new Map<string, ProviderCatalogEntry>();
	const matchedKinds = new Set<ProviderKind>();
	const matchedBaseUrls = new Set<string>();
	for (const rawProvider of root.providers) {
		const provider = object(rawProvider, "provider");
		keys(provider, new Set(["id", "match", "auth", "discovery", "runtime", "restrictToListedModels", "models"]), "provider");
		if (typeof provider.id !== "string" || provider.id.trim().length === 0) throw new Error("Invalid provider model catalog: provider id");
		const providerId = provider.id.trim();
		if (output.has(providerId)) throw new Error(`Invalid provider model catalog: duplicate provider ${providerId}`);
		const match = object(provider.match, `${providerId} match`);
		keys(match, new Set(["kinds", "baseUrls"]), `${providerId} match`);
		const kinds = stringArray(match.kinds, PROVIDER_KINDS, `${providerId} kinds`) as ProviderKind[];
		if (!Array.isArray(match.baseUrls) || match.baseUrls.some(url => typeof url !== "string")) throw new Error(`Invalid provider model catalog: ${providerId} baseUrls`);
		const baseUrls = [...new Set((match.baseUrls as string[]).map(normalizedBaseUrl))];
		if (kinds.some(kind => matchedKinds.has(kind))) throw new Error(`Invalid provider model catalog: duplicate kind ${providerId}`);
		if (baseUrls.some(url => matchedBaseUrls.has(url))) throw new Error(`Invalid provider model catalog: duplicate base URL ${providerId}`);
		kinds.forEach(kind => matchedKinds.add(kind));
		baseUrls.forEach(url => matchedBaseUrls.add(url));
		if (typeof provider.restrictToListedModels !== "boolean") throw new Error(`Invalid provider model catalog: ${providerId} restriction`);
		if (!Array.isArray(provider.models)) throw new Error(`Invalid provider model catalog: ${providerId} models`);
		if (provider.restrictToListedModels && provider.models.length === 0) throw new Error(`Invalid provider model catalog: ${providerId} models`);
		const models = new Map<string, ModelCapabilities>();
		for (const rawModel of provider.models) {
			const model = object(rawModel, `${providerId} model`);
			keys(model, new Set(["id", ...CAPABILITY_KEYS]), `${providerId} model`);
			if (typeof model.id !== "string" || model.id.trim().length === 0) throw new Error(`Invalid provider model catalog: ${providerId} model id`);
			const modelId = model.id.trim();
			if (models.has(modelId)) throw new Error(`Invalid provider model catalog: duplicate model ${providerId}:${modelId}`);
			const { id: _id, ...capabilities } = model;
			models.set(modelId, parseCapabilities(capabilities, `${providerId}:${modelId}`));
		}
		const auth = parseAuth(provider.auth, `${providerId} auth`);
		const discovery = parseDiscovery(provider.discovery, `${providerId} discovery`);
		const runtime = parseRuntime(provider.runtime, `${providerId} runtime`);
		if (runtime.adapter === "codex" && (auth.adapter !== "codex-oauth" || discovery.adapter !== "catalog")) throw new Error(`Invalid provider model catalog: ${providerId} codex adapters`);
		if (auth.adapter === "codex-oauth" && runtime.adapter !== "codex") throw new Error(`Invalid provider model catalog: ${providerId} oauth runtime`);
		output.set(providerId, {
			id: providerId,
			match: { kinds, baseUrls },
			auth,
			discovery,
			runtime,
			restrictToListedModels: provider.restrictToListedModels,
			models,
		});
	}
	return output;
}

const CATALOG = parseProviderModelCatalog(rawCatalog);
if ([...PROVIDER_KINDS].some(kind => ![...CATALOG.values()].some(entry => entry.match.kinds.includes(kind as ProviderKind)))) {
	throw new Error("Invalid provider model catalog: missing provider kind");
}
const PI_PROVIDERS: Readonly<Record<string, Provider<Api>>> = {
	"openai-codex": openaiCodexProvider(),
	"kimi-coding": kimiCodingProvider(),
	deepseek: deepseekProvider(),
	zai: zaiProvider(),
	"zai-coding-cn": zaiCodingCnProvider(),
};

export function providerDefinitionForKind(kind?: ProviderKind): ProviderCatalogEntry | undefined {
	const target = kind ?? "openai-compatible";
	for (const entry of CATALOG.values()) {
		if (entry.match.kinds.includes(target)) return entry;
	}
	return undefined;
}

function catalogId(provider: ProviderReference): string | undefined {
	if (!isCustomKind(provider.kind)) return providerDefinitionForKind(provider.kind)?.id;
	let baseUrl: string;
	try { baseUrl = normalizedBaseUrl(provider.baseUrl); }
	catch { return undefined; }
	for (const [id, entry] of CATALOG) {
		if (entry.match.baseUrls.includes(baseUrl)) return id;
	}
	return undefined;
}

function fromPiModel(model: Model<Api>): EtaModelConfig {
	const efforts = getSupportedThinkingLevels(model).filter(level => level !== "off");
	return {
		id: model.id,
		name: model.name,
		input: [...model.input],
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		reasoning: model.reasoning,
		...(model.reasoning ? { reasoningEfforts: efforts } : {}),
	};
}

/** Canonical provider-scoped model list, enriched by pi and corrected by Eta's checked-in metadata. */
export function providerModelCatalog(provider: ProviderReference): EtaModelConfig[] {
	const id = catalogId(provider);
	if (id === undefined) return [];
	const entry = CATALOG.get(id)!;
	const piModels = new Map((PI_PROVIDERS[id]?.getModels() ?? []).map(model => [model.id, fromPiModel(model)]));
	const ids = entry.restrictToListedModels ? [...entry.models.keys()] : [...new Set([...piModels.keys(), ...entry.models.keys()])];
	return ids.map(modelId => ({ id: modelId, ...piModels.get(modelId), ...entry.models.get(modelId) }));
}

export function providerModelDefinition(provider: ProviderReference, modelId: string): EtaModelConfig | undefined {
	return providerModelCatalog(provider).find(model => model.id === modelId);
}

export function providerCatalogRestrictsModels(provider: ProviderReference): boolean {
	if (isCustomKind(provider.kind)) return false;
	return providerDefinitionForKind(provider.kind)?.restrictToListedModels === true;
}

/** Resolve saved entries and keep a restricted provider from exposing manually injected aliases. */
export function resolveConfiguredModels(provider: ProviderReference, models: EtaModelConfig[]): EtaModelConfig[] {
	const restricted = providerCatalogRestrictsModels(provider);
	return models.flatMap(model => {
		const catalog = providerModelDefinition(provider, model.id);
		if (restricted && catalog === undefined) return [];
		return [{ ...(catalog ?? {}), ...model, id: model.id }];
	});
}
