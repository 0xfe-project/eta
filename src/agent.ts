/**
 * Session agent factory: persona card -> stable prompt block, and either the
 * real anthropic provider (ANTHROPIC_API_KEY set) or a faux echo provider so
 * the whole stack is demoable with zero keys.
 */

import { BACKGROUND_CONTEXT, EtaAgent } from "@eta/core";
import { DEFAULT_SYSTEM_PROMPT } from "@eta/core/prompts";
import { createModels, fauxAssistantMessage, fauxProvider, type Context, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { MemoryStorage, StorageBackedSession } from "@eta/core";
import { renderPersonaFor } from "./personas.ts";

export interface SessionConfig {
	name: string;
	personaId: string;
	cwd: string;
	env?: Record<string, string | undefined>;
	modelId?: string;
}

export class UnknownPersonaError extends Error {}

export interface CreatedSession {
	agent: EtaAgent;
	faux: FauxProviderHandle | undefined;
}

export async function createSessionAgent(cfg: SessionConfig): Promise<CreatedSession> {
	const env = cfg.env ?? process.env;
	const persona = await renderPersonaFor(cfg.cwd, cfg.personaId);
	if (persona === undefined) throw new UnknownPersonaError(`unknown persona: ${cfg.personaId}`);
	const models = env.ANTHROPIC_API_KEY === undefined || env.ANTHROPIC_API_KEY === "" ? undefined : builtinModels();
	let model = models?.getModel("anthropic", cfg.modelId ?? "claude-sonnet-4-5") ?? models?.getModels("anthropic")[0];
	let faux: FauxProviderHandle | undefined;
	if (model === undefined || models === undefined) {
		faux = fauxProvider();
		model = faux.getModel();
		faux.setResponses([echoResponder(cfg.personaId)]);
	}
	const session = new StorageBackedSession({ id: cfg.name, createdAt: Date.now(), storageVersion: 1 }, new MemoryStorage());
	const agent = await EtaAgent.create(
		{ session, models: models ?? withFaux(faux!), model, baseSystemPrompt: DEFAULT_SYSTEM_PROMPT, persona, heartbeatMs: 0 },
		BACKGROUND_CONTEXT,
	);
	if (faux !== undefined) {
		const handle = faux;
		agent.events.on("run_end", () => {
			if (handle.getPendingResponseCount() === 0) handle.appendResponses([echoResponder(cfg.personaId)]);
		});
	}
	return { agent, faux };
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
				.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
				.join(" ");
		}
	}
	return "";
}
