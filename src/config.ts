import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createModels, createProvider, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export interface EtaModelConfig {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	input?: ("text" | "image")[];
}

export interface EtaProviderConfig {
	id: string;
	baseUrl: string;
	apiKey?: string;
	models: EtaModelConfig[];
}

export interface EtaConfig {
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
export function configModels(cfg: EtaConfig): MutableModels | undefined {
	const providers = cfg.providers ?? [];
	if (providers.length === 0) return undefined;
	const models = createModels();
	for (const provider of providers) {
		const modelList: Model<"openai-completions">[] = provider.models.map((entry) => ({
			id: entry.id,
			name: entry.name ?? entry.id,
			api: "openai-completions",
			provider: provider.id,
			baseUrl: provider.baseUrl,
			reasoning: false,
			input: entry.input ?? ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: entry.contextWindow ?? 128_000,
			maxTokens: entry.maxTokens ?? 8_192,
		}));
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
