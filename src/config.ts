import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createModels, createProvider, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

import { CodexCredentialStore, codexAuthPath, codexRuntimeProvider } from "./codex-auth.ts";

export type { EtaModelConfig } from "@eta/core/provider-config";
import { effectiveModel, modelThinkingLevels, MODEL_THINKING_LEVELS, type NetworkConfig, type EtaModelConfig, type ProviderKind } from "@eta/core/provider-config";

export interface EtaProviderConfig {
	id: string;
	name?: string;
	kind?: ProviderKind;
	baseUrl: string;
	apiKey?: string;
	models: EtaModelConfig[];
	lastRefreshedAt?: string;
}

export interface EtaConfig {
	network?: NetworkConfig;
	providers?: EtaProviderConfig[];
	/** "providerId:modelId"; first provider's first model when absent. */
	defaultModel?: string;
}

export const etaConfigPath = join(homedir(), ".eta", "config.json");

export function loadEtaConfig(path: string = etaConfigPath): EtaConfig | undefined {
	try {
		if (!existsSync(path)) return undefined;
		return JSON.parse(readFileSync(path, "utf8")) as EtaConfig;
	} catch {
		return undefined;
	}
}

/** OpenAI-compatible endpoints from the config file, no environment variables involved. */
export function configModels(cfg: EtaConfig, configPath = etaConfigPath): MutableModels | undefined {
	const providers = cfg.providers ?? [];
	if (providers.length === 0) return undefined;
	const models = createModels({ credentials: new CodexCredentialStore(codexAuthPath(configPath)) });
	for (const provider of providers) {
		if (provider.kind === "openai-codex") {
			models.setProvider(codexRuntimeProvider(provider.models));
			continue;
		}
		const modelList: Model<"openai-completions">[] = provider.models.map((configured) => {
			const entry = effectiveModel(configured);
			const levels = modelThinkingLevels(entry);
			return ({
			id: entry.id,
			name: entry.name ?? entry.id,
			api: "openai-completions",
			provider: provider.id,
			baseUrl: provider.baseUrl,
			reasoning: entry.reasoning ?? false,
			...(entry.reasoning ? {
				thinkingLevelMap: Object.fromEntries(MODEL_THINKING_LEVELS.map(level => [level, level === "off"
					? (levels.includes("off") ? "none" : provider.kind === "deepseek" ? null : undefined)
					: (levels.includes(level) ? level : null)])),
				...(provider.kind === "deepseek" ? { thinkingLevelMap: {
					off: levels.includes("off") ? "none" : null,
					minimal: levels.includes("low") ? "low" : null,
					low: levels.includes("low") ? "low" : null,
					medium: levels.includes("high") ? "high" : null,
					high: levels.includes("high") ? "high" : null,
					xhigh: levels.includes("high") ? "high" : null,
					max: levels.includes("max") ? "max" : null,
				} } : {}),
			} : {}),
			compat: {
				...(entry.reasoningEfforts?.length ? { supportsReasoningEffort: true } : {}),
				...(provider.kind === "kimi-coding" || provider.kind === "deepseek" ? {
				supportsDeveloperRole: false,
				supportsStore: false,
				supportsReasoningEffort: true,
				maxTokensField: "max_tokens" as const,
				requiresReasoningContentOnAssistantMessages: true,
				...(provider.kind === "deepseek" ? { thinkingFormat: "deepseek" as const } : {}),
				} : {}),
			},
			input: entry.input ?? ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: entry.contextWindow ?? 128_000,
			maxTokens: entry.maxTokens ?? Math.min(8_192, entry.contextWindow ?? 128_000),
		});
		});
		models.setProvider(
			createProvider({
				id: provider.id,
				baseUrl: provider.baseUrl,
				auth: {
					apiKey: {
						name: `${provider.id} key (eta config)`,
						async resolve() {
							return {
								auth: {
									apiKey: provider.apiKey && provider.apiKey.length > 0 ? provider.apiKey : "eta-no-key",
								},
								source: "eta config",
							};
						},
					},
				},
				models: modelList,
				api: openAICompletionsApi(),
			}),
		);
	}
	return models;
}

/** "provider:modelId" from defaultModel, else the first configured model. */
export function configDefaultModel(cfg: EtaConfig): { provider: string; modelId: string } | undefined {
	const first = (cfg.providers ?? []).flatMap((provider) =>
		provider.models.map((model) => ({ provider: provider.id, modelId: model.id })),
	)[0];
	if (cfg.defaultModel === undefined) return first;
	const split = cfg.defaultModel.indexOf(":");
	if (split <= 0) return first;
	return { provider: cfg.defaultModel.slice(0, split), modelId: cfg.defaultModel.slice(split + 1) };
}
