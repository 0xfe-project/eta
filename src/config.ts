import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createModels, type MutableModels } from "@earendil-works/pi-ai";

import { CodexCredentialStore, codexAuthPath } from "./codex-auth.ts";
import { resolveConfiguredModels } from "./provider-model-catalog.ts";
import { createRuntimeProvider } from "./provider-runtime.ts";

export type { EtaModelConfig } from "@eta/core/provider-config";
import { type EtaModelConfig, type NetworkConfig, type ProviderHeaders, type ProviderKind } from "@eta/core/provider-config";

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
	network?: NetworkConfig;
	providers?: EtaProviderConfig[];
	/** "providerId:modelId"; first provider's first model when absent. */
	defaultModel?: string;
}

export const etaConfigPath = join(homedir(), ".eta", "config.json");

export function loadEtaConfig(path: string = etaConfigPath): EtaConfig | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const config = JSON.parse(readFileSync(path, "utf8")) as EtaConfig;
		return {
			...config,
			...(config.providers === undefined ? {} : { providers: config.providers.map(provider => ({
				...provider,
				models: resolveConfiguredModels(provider, provider.models),
			})) }),
		};
	} catch {
		return undefined;
	}
}

/** Build every configured provider through the runtime adapter declared in the provider catalog. */
export function configModels(cfg: EtaConfig, configPath = etaConfigPath): MutableModels | undefined {
	const providers = cfg.providers ?? [];
	if (providers.length === 0) return undefined;
	const models = createModels({ credentials: new CodexCredentialStore(codexAuthPath(configPath)) });
	for (const provider of providers) {
		models.setProvider(createRuntimeProvider(provider, resolveConfiguredModels(provider, provider.models)));
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
