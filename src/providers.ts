import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	MODEL_THINKING_LEVELS, effectiveModel, modelThinkingLevels, providerPreset,
	type EtaModelConfig, type ModelCapabilities, type ProviderInput, type ProvidersView,
} from "@eta/core/provider-config";
import type { EtaConfig, EtaProviderConfig } from "./config.ts";
import { deepSeekCapabilities } from "./provider-presets.ts";

export const KIMI_CODING_BASE_URL = providerPreset("kimi-coding")!.baseUrl;
export const DEEPSEEK_BASE_URL = providerPreset("deepseek")!.baseUrl;
export type ProviderFetch = (input: string, init?: RequestInit) => Promise<Response>;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export class ProviderConfigError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, status = 400) {
		super(code);
		this.code = code;
		this.status = status;
	}
}

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ProviderConfigError("invalid_config");
	return value as Record<string, unknown>;
}

function shortText(value: unknown, maximum = 200): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) throw new ProviderConfigError("invalid_config");
	return value.trim();
}

function positive(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 100_000_000) throw new ProviderConfigError("invalid_model");
	return value;
}

function capabilities(value: unknown): ModelCapabilities {
	const item = record(value);
	const name = shortText(item.name);
	const contextWindow = positive(item.contextWindow);
	const maxTokens = positive(item.maxTokens);
	const out: ModelCapabilities = {
		...(name === undefined ? {} : { name }),
		...(contextWindow === undefined ? {} : { contextWindow }),
		...(maxTokens === undefined ? {} : { maxTokens }),
	};
	if (item.input !== undefined) {
		if (!Array.isArray(item.input) || item.input.length === 0 || item.input.some(v => v !== "text" && v !== "image")) throw new ProviderConfigError("invalid_model");
		out.input = [...new Set(item.input)] as ("text" | "image")[];
	}
	if (item.reasoning !== undefined) {
		if (typeof item.reasoning !== "boolean") throw new ProviderConfigError("invalid_model");
		out.reasoning = item.reasoning;
	}
	if (item.thinkingMode !== undefined) {
		if (item.thinkingMode !== "only" && item.thinkingMode !== "both" && item.thinkingMode !== "no") throw new ProviderConfigError("invalid_model");
		out.thinkingMode = item.thinkingMode;
	}
	if (item.reasoningEfforts !== undefined) {
		if (!Array.isArray(item.reasoningEfforts) || item.reasoningEfforts.some(level => level === "off" || !MODEL_THINKING_LEVELS.includes(level))) throw new ProviderConfigError("invalid_model");
		out.reasoningEfforts = [...new Set(item.reasoningEfforts)] as NonNullable<ModelCapabilities["reasoningEfforts"]>;
	}
	if (item.providerDefaultEffort !== undefined) {
		if (item.providerDefaultEffort === "off" || !MODEL_THINKING_LEVELS.includes(item.providerDefaultEffort as never)) throw new ProviderConfigError("invalid_model");
		out.providerDefaultEffort = item.providerDefaultEffort as ModelCapabilities["providerDefaultEffort"];
	}
	return out;
}

export function normalizeModels(value: unknown): EtaModelConfig[] {
	if (!Array.isArray(value) || value.length > 500) throw new ProviderConfigError("invalid_model");
	const ids = new Set<string>();
	return value.map(raw => {
		const item = record(raw);
		const id = shortText(item.id);
		if (id === undefined || ids.has(id)) throw new ProviderConfigError("invalid_model");
		ids.add(id);
		const model: EtaModelConfig = { id, ...capabilities(item) };
		if (item.overrides !== undefined) model.overrides = capabilities(item.overrides);
		if (item.defaultThinking !== undefined) {
			if (!modelThinkingLevels(model).includes(item.defaultThinking as never)) throw new ProviderConfigError("invalid_effort");
			model.defaultThinking = item.defaultThinking as EtaModelConfig["defaultThinking"];
		}
		const effective = effectiveModel(model);
		if (effective.contextWindow !== undefined && effective.maxTokens !== undefined && effective.maxTokens > effective.contextWindow) throw new ProviderConfigError("invalid_model");
		return model;
	});
}

function baseUrl(value: unknown): string {
	const text = shortText(value, 2048);
	try {
		const url = new URL(text ?? "");
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
		return url.href.replace(/\/+$/, "");
	} catch {
		throw new ProviderConfigError("invalid_url");
	}
}

function normalizeProvider(value: unknown, previous?: EtaProviderConfig): EtaProviderConfig {
	const item = record(value);
	const id = shortText(item.id, 80);
	if (id === undefined || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new ProviderConfigError("invalid_provider_id");
	const kind = item.kind ?? previous?.kind ?? "openai-compatible";
	if (kind !== "kimi-coding" && kind !== "deepseek" && kind !== "openai-compatible") throw new ProviderConfigError("invalid_provider");
	const url = providerPreset(kind)?.baseUrl ?? baseUrl(item.baseUrl);
	const name = shortText(item.name);
	if (item.apiKey !== undefined && item.apiKey !== null && (typeof item.apiKey !== "string" || item.apiKey.length > 8192 || /[\r\n]/.test(item.apiKey))) throw new ProviderConfigError("invalid_key");
	// Never send a saved credential to a newly edited host without re-entry.
	if (previous?.apiKey && item.apiKey === undefined && baseUrl(previous.baseUrl) !== url) throw new ProviderConfigError("key_required_for_url");
	const apiKey = item.apiKey === null ? undefined : typeof item.apiKey === "string" ? item.apiKey.trim() || undefined : previous?.apiKey;
	if (kind !== "openai-compatible" && !apiKey) throw new ProviderConfigError(kind === "deepseek" ? "deepseek_key_required" : "key_required");
	return {
		id, kind, baseUrl: url, ...(name === undefined ? {} : { name }),
		...(apiKey === undefined ? {} : { apiKey }), models: normalizeModels(item.models ?? []),
		...(previous?.lastRefreshedAt === undefined ? {} : { lastRefreshedAt: previous.lastRefreshedAt }),
	};
}

/** Strict management reads: a broken config must never be overwritten as an empty one. */
async function readConfig(path: string): Promise<{ config: EtaConfig; revision: string }> {
	let raw: string;
	try { raw = await readFile(path, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ProviderConfigError("read_failed", 500);
		raw = "";
	}
	let config: EtaConfig;
	try {
		config = raw === "" ? {} : record(JSON.parse(raw)) as EtaConfig;
		if (config.providers !== undefined && (!Array.isArray(config.providers) || config.providers.some(p => typeof p?.id !== "string" || typeof p.baseUrl !== "string" || !Array.isArray(p.models)))) throw new Error();
	} catch { throw new ProviderConfigError("invalid_saved_config", 422); }
	return { config, revision: createHash("sha256").update(raw).digest("hex") };
}

function publicView(config: EtaConfig, revision: string): ProvidersView {
	return {
		revision, ...(config.defaultModel === undefined ? {} : { defaultModel: config.defaultModel }),
		providers: (config.providers ?? []).map(provider => ({
			id: provider.id, name: provider.name, kind: provider.kind ?? "openai-compatible",
			baseUrl: provider.baseUrl, hasApiKey: !!provider.apiKey,
			models: normalizeModels(provider.models), lastRefreshedAt: provider.lastRefreshedAt,
		})),
	};
}

/** Serialized writes, optimistic revisions, and atomic replacement preserve other providers. */
export class ProviderConfigStore {
	private tail: Promise<unknown> = Promise.resolve();
	readonly path: string;
	private readonly request: ProviderFetch;
	constructor(path: string, request: ProviderFetch = fetch) { this.path = path; this.request = request; }

	async view(): Promise<ProvidersView> {
		const { config, revision } = await readConfig(this.path);
		return publicView(config, revision);
	}

	private mutate(revision: unknown, update: (config: EtaConfig) => void): Promise<ProvidersView> {
		const run = this.tail.then(async () => {
			const state = await readConfig(this.path);
			if (typeof revision !== "string" || state.revision !== revision) throw new ProviderConfigError("config_changed", 409);
			update(state.config);
			const raw = `${JSON.stringify(state.config, null, 2)}\n`;
			const temporary = `${this.path}.${randomUUID()}.tmp`;
			try {
				await mkdir(dirname(this.path), { recursive: true });
				await writeFile(temporary, raw, { encoding: "utf8", mode: 0o600, flag: "wx" });
				// Also catch an external editor changing the file while this save was prepared.
				if ((await readConfig(this.path)).revision !== revision) throw new ProviderConfigError("config_changed", 409);
				await rename(temporary, this.path);
			} catch (error) {
				if (error instanceof ProviderConfigError) throw error;
				throw new ProviderConfigError("save_failed", 500);
			} finally { await rm(temporary, { force: true }); }
			return publicView(state.config, createHash("sha256").update(raw).digest("hex"));
		});
		this.tail = run.catch(() => undefined);
		return run;
	}

	save(body: unknown): Promise<ProvidersView> {
		const input = record(body);
		return this.mutate(input.revision, config => {
			const raw = record(input.provider);
			const providers = config.providers ?? [];
			const index = providers.findIndex(p => p.id === raw.id);
			const provider = normalizeProvider(raw, index < 0 ? undefined : providers[index]);
			if (provider.models.length === 0) throw new ProviderConfigError("models_required");
			if (index < 0) providers.push(provider); else providers[index] = provider;
			config.providers = providers;
			if (input.defaultModel !== undefined) this.assignDefault(config, input.defaultModel);
			this.removeStaleDefault(config);
		});
	}

	setDefault(body: unknown): Promise<ProvidersView> {
		const input = record(body);
		return this.mutate(input.revision, config => this.assignDefault(config, input.defaultModel));
	}

	delete(id: string, revision: unknown): Promise<ProvidersView> {
		return this.mutate(revision, config => {
			config.providers = (config.providers ?? []).filter(p => p.id !== id);
			this.removeStaleDefault(config);
		});
	}

	private assignDefault(config: EtaConfig, value: unknown): void {
		if (value === null) { delete config.defaultModel; return; }
		if (typeof value !== "string" || !(config.providers ?? []).some(p => p.models.some(m => `${p.id}:${m.id}` === value))) throw new ProviderConfigError("invalid_default_model");
		config.defaultModel = value;
	}

	private removeStaleDefault(config: EtaConfig): void {
		if (config.defaultModel && !(config.providers ?? []).some(p => p.models.some(m => `${p.id}:${m.id}` === config.defaultModel))) delete config.defaultModel;
	}

	async discover(body: unknown): Promise<{ models: EtaModelConfig[] }> {
		const input = record(body);
		const raw = record(input.provider);
		const { config } = await readConfig(this.path);
		const old = config.providers?.find(p => p.id === raw.id);
		const provider = normalizeProvider(raw, old);
		const models = await discoverProviderModels(provider, this.request);
		const existing = new Map(provider.models.map(model => [model.id, model]));
		return { models: models.map(model => {
			const previous = existing.get(model.id);
			const merged = { ...model, ...(provider.kind === "openai-compatible" && previous?.overrides ? { overrides: previous.overrides } : {}) };
			return previous?.defaultThinking !== undefined && modelThinkingLevels(merged).includes(previous.defaultThinking)
				? { ...merged, defaultThinking: previous.defaultThinking } : merged;
		}) };
	}
}

export async function discoverProviderModels(provider: EtaProviderConfig, request: ProviderFetch = fetch): Promise<EtaModelConfig[]> {
	let response: Response;
	try {
		response = await request(`${provider.baseUrl.replace(/\/+$/, "")}/models`, {
			headers: { Accept: "application/json", ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}) },
			signal: AbortSignal.timeout(15_000), redirect: "error",
		});
	} catch { throw new ProviderConfigError("connection_failed", 502); }
	if (!response.ok) {
		await response.body?.cancel();
		throw new ProviderConfigError(response.status === 401 ? "authentication_failed" : response.status === 403 ? "access_denied" : response.status === 429 ? "rate_limited" : "upstream_failed", 502);
	}
	let text = "";
	try {
		const reader = response.body?.getReader();
		if (!reader) throw new Error();
		const decoder = new TextDecoder();
		let size = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > MAX_BODY_BYTES) throw new Error();
				text += decoder.decode(value, { stream: true });
			}
			text += decoder.decode();
		} finally { await reader.cancel(); }
	} catch { throw new ProviderConfigError("invalid_models_response", 502); }
	let data: unknown;
	try { data = record(JSON.parse(text)).data; }
	catch { throw new ProviderConfigError("invalid_models_response", 502); }
	if (!Array.isArray(data) || data.length > 500) throw new ProviderConfigError("invalid_models_response", 502);
	const models: EtaModelConfig[] = [];
	const ids = new Set<string>();
	for (const raw of data) {
		if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id.trim() || ids.has(raw.id)) continue;
		ids.add(raw.id);
		const effort = raw.think_efforts;
		const reasoningEfforts = effort?.support === true && Array.isArray(effort.valid_efforts)
			? MODEL_THINKING_LEVELS.filter(level => level !== "off" && effort.valid_efforts.includes(level)) as NonNullable<ModelCapabilities["reasoningEfforts"]> : undefined;
		const thinkingMode = ["only", "no", "both"].includes(raw.supports_thinking_type) ? raw.supports_thinking_type as ModelCapabilities["thinkingMode"] : undefined;
		const reasoning = thinkingMode ? thinkingMode !== "no" : typeof raw.supports_reasoning === "boolean" ? raw.supports_reasoning : undefined;
		const context = Number(raw.context_length);
		if (provider.kind === "kimi-coding" && (!Number.isSafeInteger(context) || context <= 0)) throw new ProviderConfigError("invalid_models_response", 502);
		const discovered: EtaModelConfig = {
			...(provider.kind === "deepseek" ? deepSeekCapabilities(raw.id) : {}),
			id: raw.id,
			...(typeof raw.display_name === "string" ? { name: raw.display_name } : {}),
			...(Number.isSafeInteger(context) && context > 0 ? { contextWindow: context } : {}),
			...(typeof raw.supports_image_in === "boolean" ? { input: raw.supports_image_in ? ["text", "image"] : ["text"] } : {}),
			...(reasoning === undefined ? {} : { reasoning }),
			...(thinkingMode === undefined ? {} : { thinkingMode }),
			...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
			...(reasoningEfforts?.includes(effort?.default_effort) ? { providerDefaultEffort: effort.default_effort } : {}),
		};
		if (provider.kind === "deepseek" && effort && typeof effort.support === "boolean") {
			discovered.reasoningEfforts = reasoningEfforts ?? [];
			delete discovered.providerDefaultEffort;
			if (reasoningEfforts?.includes(effort.default_effort)) discovered.providerDefaultEffort = effort.default_effort;
		}
		if (discovered.contextWindow !== undefined && discovered.maxTokens !== undefined) {
			discovered.maxTokens = Math.min(discovered.maxTokens, discovered.contextWindow);
		}
		models.push(discovered);
	}
	if (models.length === 0) throw new ProviderConfigError("no_models", 502);
	try { return normalizeModels(models); }
	catch { throw new ProviderConfigError("invalid_models_response", 502); }
}
