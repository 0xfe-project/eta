/**
 * Session agent factory: persona card -> stable prompt block, then the model,
 * by priority: the eta config file (~/.eta/config.json, any number of
 * openai-compatible providers), ANTHROPIC_API_KEY's anthropic catalog, or a
 * faux echo provider so the whole stack is demoable with zero config.
 */

import { join } from "node:path";
import { BACKGROUND_CONTEXT, EtaAgent, MemoryCache, type MemoryLoaded } from "@eta/core";
import { homedir } from "node:os";
import { complete } from "@earendil-works/pi-ai/compat";
import { NodeEtaFs } from "./node-fs.ts";
import { DEFAULT_SYSTEM_PROMPT } from "@eta/core/prompts";
import { FileStorage, NodeExecutionEnv } from "@eta/core/node";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	type Context,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { MemoryStorage, StorageBackedSession } from "@eta/core";
import { configDefaultModel, configModels, loadEtaConfig } from "./config.ts";
import { renderPersonaFor } from "./personas.ts";
import { discoverSkillDirs, renderSkillsBlock, watchSkillDirs } from "./skills.ts";

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
}

export class UnknownPersonaError extends Error {}

export interface CreatedSession {
	agent: EtaAgent;
	faux: FauxProviderHandle | undefined;
	memory?: () => Promise<MemoryLoaded>;
}

export async function createSessionAgent(cfg: SessionConfig): Promise<CreatedSession> {
	const env = cfg.env ?? process.env;
	const persona = await renderPersonaFor(cfg.cwd, cfg.personaId);
	if (persona === undefined) throw new UnknownPersonaError(`unknown persona: ${cfg.personaId}`);
	const etaConfig = loadEtaConfig(cfg.configPath) ?? {};
	let models = configModels(etaConfig);
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
	const memoryTarget = (await memoryCache.load(cfg.cwd)).target;
	const extractionModel = model;
	const judgeApiKey = providerApiKey(etaConfig, model.provider);
	const execEnv = new NodeExecutionEnv({ cwd: cfg.cwd });
	const skillsBlock = await renderSkillsBlock(execEnv, cfg.cwd);
	const agent = await EtaAgent.create(
		{
			session,
			models: models ?? withFaux(faux!),
			model,
			baseSystemPrompt: DEFAULT_SYSTEM_PROMPT,
			executionEnv: execEnv,
			skillsSection: skillsBlock === "" ? undefined : skillsBlock,
			persona,
			...(cfg.heartbeatMs === undefined ? {} : { heartbeatMs: cfg.heartbeatMs }),
			memorySource: async () => (await memoryCache.load(cfg.cwd)).text,
			// The faux provider answers from a queue the run itself consumes; an extraction
			// call would eat a response and get an echo back, so no notes in a faux session.
			...(faux === undefined
				? {
						memoryExtraction: {
							fs: memoryFs,
							target: memoryTarget,
							call: async (systemPrompt: string, prompt: string) => {
								const reply = await complete(
									extractionModel,
									{
										systemPrompt,
										messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
									},
									{ apiKey: judgeApiKey },
								);
								return reply.content
									.filter((block): block is { type: "text"; text: string } => block.type === "text")
									.map((block) => block.text)
									.join("");
								},
							},
						}
					: {}),
			evaluateGoal:
				faux !== undefined
					? async () => false
					: async (objective, messages) => {
							const tail = messages
								.slice(-8)
								.map((message) => transcriptText(message))
								.filter((line) => line.length > 0)
								.join("\n---\n")
								.slice(-2_400);
							try {
								const verdict = await complete(
									model,
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
									{ apiKey: judgeApiKey },
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
	return { agent, faux, memory: async () => memoryCache.load(cfg.cwd) };
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

function providerApiKey(config: { providers?: { id: string; apiKey?: string }[] }, providerId: string): string {
	const provider = (config.providers ?? []).find((entry) => entry.id === providerId);
	return provider?.apiKey && provider.apiKey.length > 0 ? provider.apiKey : "eta-no-key";
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
