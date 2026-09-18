/**
 * Session agent factory: persona card -> stable prompt block, then the model,
 * by priority: the eta config file (~/.eta/config.json, any number of
 * openai-compatible providers), ANTHROPIC_API_KEY's anthropic catalog, or a
 * faux echo provider so the whole stack is demoable with zero config.
 */

import { join } from "node:path";
import { BACKGROUND_CONTEXT, EtaAgent, MemoryCache, type MemoryLoaded } from "@eta/core";
import { homedir } from "node:os";
import { NodeEtaFs } from "./node-fs.ts";
import { DEFAULT_SYSTEM_PROMPT } from "@eta/core/prompts";
import { FileStorage, NodeExecutionEnv } from "@eta/core/node";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	type Context,
	type FauxProviderHandle,
	type MutableModels,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { MemoryStorage, StorageBackedSession } from "@eta/core";
import { configDefaultModel, configModels, etaConfigPath, loadEtaConfig, type EtaConfig } from "./config.ts";
import { renderPersonaFor } from "./personas.ts";
import { discoverSkillDirs, renderSkillsBlock, watchSkillDirs } from "./skills.ts";
import { renderPlatformBlock } from "./platform-prompt.ts";

export interface SessionConfig {
	name: string;
	personaId: string;
	cwd: string;
	env?: Record<string, string | undefined>;
	modelId?: string;
	/** Config file location; tests inject a nonexistent path to stay offline. */
	configPath?: string;
	/** Session journal lives here (append-only). In-memory when absent (tests). */
	persistDir?: string;
	/** Loop wake cadence; see HostOptions. */
	heartbeatMs?: number;
	keepRecentTokens?: number;
}

export class UnknownPersonaError extends Error {}

export interface CreatedSession {
	agent: EtaAgent;
	faux: FauxProviderHandle | undefined;
	models?: MutableModels;
	memory?: () => Promise<MemoryLoaded>;
	/** Replace configured providers at an idle boundary without replacing the session. */
	reloadModels?: (config: EtaConfig) => void;
}

export async function createSessionAgent(cfg: SessionConfig): Promise<CreatedSession> {
	const env = cfg.env ?? process.env;
	const persona = await renderPersonaFor(cfg.cwd, cfg.personaId);
	if (persona === undefined) throw new UnknownPersonaError(`unknown persona: ${cfg.personaId}`);
	const etaConfig = loadEtaConfig(cfg.configPath) ?? {};
	let models = configModels(etaConfig, cfg.configPath);
	let model: ReturnType<typeof builtinModels>["getModel"] extends (p: string, id: string) => infer R
		? R | undefined
		: never;
	if (models !== undefined) {
		const wanted = cfg.modelId ?? "";
		const split = wanted.indexOf(":");
		const fallback = configDefaultModel(etaConfig);
		if (split > 0) model = models.getModel(wanted.slice(0, split), wanted.slice(split + 1));
		else if (fallback !== undefined)
			model =
				models.getModel(fallback.provider, cfg.modelId ?? fallback.modelId) ??
				models.getModel(fallback.provider, fallback.modelId);
		if (model === undefined) {
			for (const provider of etaConfig.providers ?? []) {
				model = models.getModel(provider.id, cfg.modelId ?? provider.models[0]?.id ?? "");
				if (model !== undefined) break;
			}
		}
		// The asked-for id is not in the registry — a model that was renamed, a provider whose
		// key went away. Falling back to the configured default keeps the session talking to a
		// real model; going quiet on an echo instead would leave the panel naming a model the
		// run never touched, which reads as the switch having worked.
		if (model === undefined && wanted.length > 0) {
			const substitute =
				(fallback === undefined ? undefined : models.getModel(fallback.provider, fallback.modelId)) ??
				(etaConfig.providers ?? []).flatMap((provider) => provider.models.map((entry) => models!.getModel(provider.id, entry.id)))[0];
			if (substitute !== undefined) {
				console.warn(`[eta-agent] ${cfg.name}: model "${wanted}" is not configured, running on ${substitute.provider}:${substitute.id} instead`);
				model = substitute;
			}
		}
	}
	const anthropic = env.ANTHROPIC_API_KEY === undefined || env.ANTHROPIC_API_KEY === "" ? undefined : builtinModels();
	if (model === undefined && models === undefined && anthropic !== undefined) {
		models = anthropic;
		model =
			anthropic.getModel("anthropic", cfg.modelId ?? "claude-sonnet-4-5") ?? anthropic.getModels("anthropic")[0];
	}
	let faux: FauxProviderHandle | undefined;
	if (model === undefined || models === undefined) {
		faux = fauxProvider();
		model = faux.getModel();
		faux.setResponses([echoResponder(cfg.personaId)]);
		models ??= createModels();
		models.setProvider(faux.provider);
	}
	const storage =
		cfg.persistDir === undefined
			? new MemoryStorage()
			: await FileStorage.load({ path: join(cfg.persistDir, "journal.jsonl") }, BACKGROUND_CONTEXT);
	const session = new StorageBackedSession(
		{ id: cfg.name, createdAt: Date.now(), storageVersion: 1, cwd: cfg.cwd },
		storage,
	);
	const memoryFs = new NodeEtaFs();
	const memoryCache = new MemoryCache(memoryFs, homedir());
	// The project's own MEMORY.md — the nearest one if the tree keeps several, else
	// `<projectRoot>/.eta/MEMORY.md`, which NodeEtaFs.writeFile creates on the first note.
	// Memory is project-scoped: a session opened in another folder starts with a clean sheet
	// there, and the notes it earns stay with that folder.
	const loadedMemory = await memoryCache.load(cfg.cwd);
	const memoryTarget = loadedMemory.target;
	const registry = models ?? withFaux(faux!);
	let configuredIds = (etaConfig.providers ?? []).map(provider => provider.id);
	let agent: EtaAgent;
	const selectedModel = async () => (await agent.lane.getModel(BACKGROUND_CONTEXT)) ?? model!;
	const isFaux = async () => (await selectedModel()).provider === faux?.provider.id;
	const execEnv = new NodeExecutionEnv({ cwd: cfg.cwd });
	const skillsBlock = await renderSkillsBlock(execEnv, cfg.cwd);
	// Where the app's own files live, in terms of this session: the agent is told the paths
	// it would actually write to, not a description of a generic home directory.
	const platformBlock = renderPlatformBlock({
		cwd: cfg.cwd,
		configPath: cfg.configPath ?? etaConfigPath,
		...(cfg.persistDir === undefined ? {} : { sessionDir: cfg.persistDir }),
		memoryTarget: memoryTarget.path,
		memoryExists: loadedMemory.files.length > 0,
	});
	agent = await EtaAgent.create(
		{
			session,
			models: registry,
			model,
			baseSystemPrompt: DEFAULT_SYSTEM_PROMPT,
			executionEnv: execEnv,
			skillsSection: skillsBlock === "" ? undefined : skillsBlock,
			platformSection: platformBlock,
			persona,
			...(cfg.heartbeatMs === undefined ? {} : { heartbeatMs: cfg.heartbeatMs }),
			memorySource: async () => (await memoryCache.load(cfg.cwd)).text,
			memoryExtraction: {
				fs: memoryFs,
				target: memoryTarget,
				call: async (systemPrompt: string, prompt: string) => {
					if (await isFaux()) return "";
					const reply = await registry.completeSimple(await selectedModel(), {
						systemPrompt, messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
					});
					return reply.content.filter(block => block.type === "text").map(block => block.text).join("");
				},
			},
			evaluateGoal: async (objective, messages) => {
							if (await isFaux()) return false;
							const tail = messages
								.slice(-8)
								.map((message) => transcriptText(message))
								.filter((line) => line.length > 0)
								.join("\n---\n")
								.slice(-2_400);
							try {
								const verdict = await registry.completeSimple(
									await selectedModel(),
									{
										systemPrompt:
											"You are a strict goal-completion judge. Reply with exactly ACHIEVED if the objective is fully satisfied by the shown work, otherwise CONTINUE.",
										messages: [
											{
												role: "user",
												content: `Objective: ${objective}\n\nRecent work:\n${tail}`,
												timestamp: Date.now(),
											},
										],
									},
								);
								const text = verdict.content
									.filter((block): block is { type: "text"; text: string } => block.type === "text")
									.map((block) => block.text)
									.join("")
									.trim()
									.toUpperCase();
								return text.startsWith("ACHIEVED");
							} catch {
								return false;
							}
						},
		},
		BACKGROUND_CONTEXT,
	);
	if (cfg.keepRecentTokens !== undefined) {
		const compaction = await agent.harness.getCompactionSettings(BACKGROUND_CONTEXT);
		await agent.harness.setCompactionSettings({ ...compaction, keepRecentTokens: cfg.keepRecentTokens }, BACKGROUND_CONTEXT);
	}
	if (faux !== undefined) {
		const handle = faux;
		agent.events.on("run_end", () => {
			if (handle.getPendingResponseCount() === 0) handle.appendResponses([echoResponder(cfg.personaId)]);
		});
	}
	let skillsTimer: ReturnType<typeof setTimeout> | undefined;
	watchSkillDirs(discoverSkillDirs(cfg.cwd), () => {
		clearTimeout(skillsTimer);
		skillsTimer = setTimeout(
			() => void renderSkillsBlock(execEnv, cfg.cwd).then((block) => agent.applySkills(block)),
			300,
		);
	});
	return {
		agent, faux, models: registry, memory: async () => memoryCache.load(cfg.cwd),
		reloadModels(config) {
			const next = configModels(config, cfg.configPath);
			for (const id of configuredIds) registry.deleteProvider(id);
			for (const provider of next?.getProviders() ?? []) registry.setProvider(provider);
			configuredIds = (config.providers ?? []).map(provider => provider.id);
		},
	};
}

function withFaux(faux: FauxProviderHandle) {
	const models = createModels();
	models.setProvider(faux.provider);
	return models;
}

function echoResponder(personaId: string) {
	return (context: Context) => {
		const heard = lastUserText(context.messages).slice(0, 200);
		return fauxAssistantMessage(`[${personaId} faux echo] ${heard}`);
	};
}

function lastUserText(messages: readonly { role: string; content: unknown }[]): string {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i]!;
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		if (Array.isArray(message.content)) {
			return message.content
				.map((part) =>
					typeof part === "object" && part !== null && "text" in part
						? String((part as { text?: unknown }).text ?? "")
						: "",
				)
				.join(" ");
		}
	}
	return "";
}

function transcriptText(message: unknown): string {
	const record = message as { role?: string; content?: unknown };
	if (record.role !== "assistant" && record.role !== "user") return "";
	if (typeof record.content === "string") return `${record.role}: ${record.content}`;
	if (!Array.isArray(record.content)) return "";
	const text = (record.content as { type?: string; text?: string }[])
		.filter((block) => block.type === "text" && (block.text ?? "").trim().length > 0)
		.map((block) => block.text!.trim())
		.join("\n");
	return text.length === 0 ? "" : `${record.role}: ${text}`;
}
