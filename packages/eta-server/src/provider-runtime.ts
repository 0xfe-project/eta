import {
	createProvider, type Api, type Model, type OpenAICompletionsCompat, type Provider, type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
	MODEL_THINKING_LEVELS, effectiveModel, modelThinkingLevels, sanitizeProviderHeaders,
	type EtaModelConfig,
} from "@eta/core/provider-config";
import type { EtaProviderConfig } from "./config.ts";
import { codexRuntimeProvider } from "./codex-auth.ts";
import {
	providerDefinitionForKind, type ProviderCatalogEntry, type ProviderRuntimeDefinition,
} from "./provider-model-catalog.ts";

interface RuntimeFactoryInput {
	provider: EtaProviderConfig;
	models: EtaModelConfig[];
	definition: ProviderCatalogEntry;
}

type RuntimeFactory = (input: RuntimeFactoryInput) => Provider<Api>;

function wireHeaders(provider: EtaProviderConfig): Record<string, string> | undefined {
	const configured = sanitizeProviderHeaders(provider.headers);
	return configured === undefined ? undefined : Object.fromEntries(
		Object.entries(configured).filter((entry): entry is [string, string] => entry[1] !== null),
	);
}

function standardThinkingLevelMap(model: EtaModelConfig, runtime: ProviderRuntimeDefinition): ThinkingLevelMap {
	const levels = modelThinkingLevels(model);
	return Object.fromEntries(MODEL_THINKING_LEVELS.map(level => [level, level === "off"
		? (runtime.thinking === "zai" ? null : levels.includes("off") ? "none" : undefined)
		: (levels.includes(level) ? level : null)])) as ThinkingLevelMap;
}

function deepSeekThinkingLevelMap(model: EtaModelConfig): ThinkingLevelMap {
	const levels = modelThinkingLevels(model);
	return {
		off: levels.includes("off") ? "none" : null,
		minimal: levels.includes("low") ? "low" : null,
		low: levels.includes("low") ? "low" : null,
		medium: levels.includes("high") ? "high" : null,
		high: levels.includes("high") ? "high" : null,
		xhigh: levels.includes("high") ? "high" : null,
		max: levels.includes("max") ? "max" : null,
	};
}

function thinkingLevelMap(model: EtaModelConfig, runtime: ProviderRuntimeDefinition): ThinkingLevelMap {
	return runtime.thinking === "deepseek" ? deepSeekThinkingLevelMap(model) : standardThinkingLevelMap(model, runtime);
}

function commonModel<TApi extends "openai-completions" | "openai-responses">(
	provider: EtaProviderConfig,
	configured: EtaModelConfig,
	api: TApi,
	headers: Record<string, string> | undefined,
	runtime: ProviderRuntimeDefinition,
): Model<TApi> {
	const model = effectiveModel(configured);
	return {
		id: model.id,
		name: model.name ?? model.id,
		api,
		provider: provider.id,
		baseUrl: provider.baseUrl,
		...(headers === undefined ? {} : { headers }),
		reasoning: model.reasoning ?? false,
		...(model.reasoning ? { thinkingLevelMap: thinkingLevelMap(model, runtime) } : {}),
		input: model.input ?? ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow ?? 128_000,
		maxTokens: model.maxTokens ?? Math.min(8_192, model.contextWindow ?? 128_000),
	} as Model<TApi>;
}

function chatCompat(model: EtaModelConfig, runtime: ProviderRuntimeDefinition): OpenAICompletionsCompat {
	const effective = effectiveModel(model);
	return {
		...(effective.reasoningEfforts?.length || runtime.thinking !== undefined ? { supportsReasoningEffort: true } : {}),
		...(runtime.developerRole === undefined ? {} : { supportsDeveloperRole: runtime.developerRole }),
		...(runtime.store === undefined ? {} : { supportsStore: runtime.store }),
		...(runtime.maxTokensField === undefined ? {} : { maxTokensField: runtime.maxTokensField }),
		...(runtime.replayReasoningContent === undefined ? {} : { requiresReasoningContentOnAssistantMessages: runtime.replayReasoningContent }),
		...(runtime.thinking === "deepseek" || runtime.thinking === "zai" ? { thinkingFormat: runtime.thinking } : {}),
		...(runtime.toolStream === "zai" ? { zaiToolStream: true } : {}),
	};
}

function apiKeyAuth(provider: EtaProviderConfig) {
	return {
		apiKey: {
			name: `${provider.id} key (eta config)`,
			async resolve() {
				return {
					auth: { apiKey: provider.apiKey && provider.apiKey.length > 0 ? provider.apiKey : "eta-no-key" },
					source: "eta config",
				};
			},
		},
	};
}

function createOpenAIChatProvider(input: RuntimeFactoryInput): Provider<"openai-completions"> {
	const headers = wireHeaders(input.provider);
	const models = input.models.map(configured => ({
		...commonModel(input.provider, configured, "openai-completions", headers, input.definition.runtime),
		compat: chatCompat(configured, input.definition.runtime),
	}));
	return createProvider({
		id: input.provider.id,
		baseUrl: input.provider.baseUrl,
		auth: apiKeyAuth(input.provider),
		models,
		api: openAICompletionsApi(),
	});
}

function createOpenAIResponsesProvider(input: RuntimeFactoryInput): Provider<"openai-responses"> {
	const headers = wireHeaders(input.provider);
	return createProvider({
		id: input.provider.id,
		baseUrl: input.provider.baseUrl,
		auth: apiKeyAuth(input.provider),
		models: input.models.map(configured => commonModel(input.provider, configured, "openai-responses", headers, input.definition.runtime)),
		api: openAIResponsesApi(),
	});
}

const RUNTIME_ADAPTERS: Readonly<Record<ProviderRuntimeDefinition["adapter"], RuntimeFactory>> = {
	"openai-chat": createOpenAIChatProvider,
	"openai-responses": createOpenAIResponsesProvider,
	codex: input => codexRuntimeProvider(input.models),
};

export function createRuntimeProvider(provider: EtaProviderConfig, models: EtaModelConfig[]): Provider<Api> {
	const definition = providerDefinitionForKind(provider.kind);
	if (definition === undefined) throw new Error(`Unsupported provider kind: ${String(provider.kind)}`);
	return RUNTIME_ADAPTERS[definition.runtime.adapter]({ provider, models, definition });
}
