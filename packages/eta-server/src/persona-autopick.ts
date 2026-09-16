/**
 * Auto-pick the persona for a chat whose person hit send without touching a chip.
 *
 * One call to the model the chat is about to run on — capped in tokens, not in time — asking
 * for one id off the card list it will actually be rendered from. Every failure path — no model
 * configured, the call failing, prose where an id belonged, an id that is not a card — lands on
 * the fallback card instead of on a failed send. The message is already typed: a chat that
 * refuses to start over a chip nobody picked is worse than a chat that opens on the wrong card
 * and says so.
 */

import { homedir } from "node:os";
import { discoverPersonas } from "@eta/core";
import { contentText, type Api, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { configDefaultModel, configModels, loadEtaConfig, type EtaConfig } from "./config.ts";
import { NodeEtaFs } from "./node-fs.ts";
import { FALLBACK_PERSONA, describeCard } from "./personas.ts";

/** The first message is a hint about tone, not a document to read. */
const MAX_PROMPT_CHARS = 1_200;
/**
 * Room for a thinking model to think and still reach the id. There is no deadline on this call:
 * a slow pick is the person waiting a moment for a card that fits them, which is a fine trade,
 * while a cut-off pick is the fallback card wearing the model's decision — the worse of the two.
 * The cap stays because an unbounded one lets a rambling reasoner spend the model's whole budget
 * to say one word, not because the answer is expected to be slow.
 */
const MAX_ANSWER_TOKENS = 1_024;

const PICKER_SYSTEM_PROMPT =
	"You choose the persona card for a chat that is about to start. Reply with exactly one id from the list and nothing else: no quotes, no punctuation, no sentence.";

/** Why a card was chosen, so the host can say out loud when the model did not decide. */
export type PersonaPickSource = "model" | "preferred" | "fallback";

export interface PersonaPick {
	id: string;
	source: PersonaPickSource;
}

/** The card to open on when the model gets no vote: the configured default, then Thinker. */
export function fallbackPersonaId(cards: Record<string, string>, preferred?: string): PersonaPick {
	if (preferred !== undefined && preferred in cards) return { id: preferred, source: "preferred" };
	if (FALLBACK_PERSONA in cards) return { id: FALLBACK_PERSONA, source: "fallback" };
	const first = Object.keys(cards)[0];
	return { id: first ?? FALLBACK_PERSONA, source: "fallback" };
}

function escapeForLiteral(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Which card the answer names. Ids are matched as whole tokens — a card named `Executor` must
 * not be claimed by "execute" — and the earliest mention wins, because a model that hedges
 * between two cards states its pick first. Returns undefined when nothing on the list appears.
 */
export function parsePersonaAnswer(text: string, ids: string[]): string | undefined {
	const haystack = text.toLowerCase();
	let best: { id: string; at: number } | undefined;
	for (const id of ids) {
		if (id.length === 0) continue;
		const match = new RegExp(`(^|[^a-z0-9_-])${escapeForLiteral(id.toLowerCase())}($|[^a-z0-9_-])`).exec(haystack);
		if (match === null) continue;
		const at = match.index + (match[1]?.length ?? 0);
		if (best === undefined || at < best.at || (at === best.at && id.length > best.id.length)) best = { id, at };
	}
	return best?.id;
}

/** The model's vote, or undefined when the call produced nothing usable. */
export async function choosePersona(input: {
	models: MutableModels;
	model: Model<Api>;
	cards: Record<string, string>;
	prompt: string;
}): Promise<string | undefined> {
	const ids = Object.keys(input.cards);
	const menu = ids.map((id) => `- ${id}: ${describeCard(input.cards[id] ?? "")}`).join("\n");
	let answer: string;
	try {
		const reply = await input.models.completeSimple(
			input.model,
			{
				systemPrompt: PICKER_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: `Persona ids:\n${menu}\n\nFirst message of the chat:\n${input.prompt.slice(0, MAX_PROMPT_CHARS)}`,
						timestamp: Date.now(),
					},
				],
			},
			// No effort is asked for, which is how pi says "use the card's off switch": a model
			// that can stop thinking answers this without thinking, and one that always thinks
			// (llama.cpp's chat template) just thinks, and gets the room above to finish in.
			{ maxTokens: MAX_ANSWER_TOKENS },
		);
		if (reply.stopReason === "error" || reply.stopReason === "aborted") return undefined;
		answer = contentText(reply.content);
	} catch {
		return undefined;
	}
	return parsePersonaAnswer(answer, ids);
}

/** The model the chat will run on, so the card it picks is one it can hold. */
function pickableModel(
	models: MutableModels | undefined,
	etaConfig: EtaConfig,
	modelId: string | undefined,
): Model<Api> | undefined {
	if (models === undefined) return undefined;
	const wanted = (modelId ?? "").trim();
	const split = wanted.indexOf(":");
	if (split > 0) {
		const exact = models.getModel(wanted.slice(0, split), wanted.slice(split + 1));
		if (exact !== undefined) return exact;
	}
	const bare = split > 0 ? undefined : wanted.length > 0 ? wanted : undefined;
	const fallback = configDefaultModel(etaConfig);
	if (fallback !== undefined) {
		const onDefaultProvider = models.getModel(fallback.provider, bare ?? fallback.modelId);
		if (onDefaultProvider !== undefined) return onDefaultProvider;
	}
	for (const provider of etaConfig.providers ?? []) {
		const owned = models.getModel(provider.id, bare ?? provider.models[0]?.id ?? "");
		if (owned !== undefined) return owned;
	}
	return models.getModels()[0];
}

/**
 * The card a chat with no picked persona opens on. Offline and unconfigured hosts take the
 * fast path: with no model registered there is nothing to ask, so no request is even attempted.
 */
export async function suggestPersonaId(input: {
	cwd: string;
	prompt: string;
	configPath?: string;
	modelId?: string;
	preferredId?: string;
	etaConfig?: EtaConfig;
}): Promise<PersonaPick> {
	const cards = await discoverPersonas(new NodeEtaFs(), input.cwd, homedir());
	const fallback = fallbackPersonaId(cards, input.preferredId);
	const prompt = input.prompt.trim();
	if (prompt.length === 0) return fallback;
	const etaConfig = input.etaConfig ?? loadEtaConfig(input.configPath) ?? {};
	const models = configModels(etaConfig, input.configPath);
	const model = pickableModel(models, etaConfig, input.modelId);
	if (models === undefined || model === undefined) return fallback;
	const picked = await choosePersona({ models, model, cards, prompt });
	return picked === undefined ? fallback : { id: picked, source: "model" };
}
