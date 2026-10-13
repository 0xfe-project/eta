/**
 * Persona cards: finding them, reading them, and picking one for a session.
 *
 * A card is a markdown file, `<id>.persona.md`, in one of two places:
 *
 * ```
 * ~/.eta/persona/<id>.persona.md     every session, everywhere
 * <cwd>/.eta/persona/<id>.persona.md this project only
 * ```
 *
 * And then there are the built-in cards (`builtinPersonas`, the harness's battery): they are
 * the floor of the same namespace, not a directory — every file shadows them by naming one,
 * and none of them can be deleted. A session left on `Thinker` must open on `Thinker` even on
 * a machine nobody has written a card on.
 *
 * The project's cards win on a name clash — a project that has an opinion about `Executor` means
 * it, and the user's home card is the general case. Discovery is re-run whenever it is asked for,
 * so dropping a file in shows up without a restart, and a *broken* card (unreadable, empty) is a
 * card that is simply absent rather than a crash: a session must not fail to open because a file
 * in a directory it never named is malformed.
 *
 * `autopick` is the other half: a chat whose user did not choose a card gets one suggested by one
 * model call. Every failure path — no model, a failed call, prose where an id belonged, an id that
 * is not a card — lands on the fallback. The message is already typed; refusing to start a chat
 * over a chip nobody picked is worse than opening on the wrong card and saying so.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PersonaCard } from "@eta/core";
import { builtinPersonas } from "@eta/harness";

/** The fallback card's name, matching eta-agent's own. */
export const FALLBACK_PERSONA = "Thinker";

/** The persona directories that apply to one working directory, most specific first. */
export function personaDirs(cwd: string, home: string): string[] {
	return [join(cwd, ".eta", "persona"), join(home, ".eta", "persona")];
}

export interface DiscoverPersonasOptions {
	cwd: string;
	home: string;
	/** Diagnostics: a card that could not be read. */
	warn?: ((message: string) => void) | undefined;
}

/** Every card that applies here, keyed by id. The project's cards win on a clash. */
export async function discoverPersonas(options: DiscoverPersonasOptions): Promise<Map<string, PersonaCard>> {
	const cards = new Map<string, PersonaCard>();
	// The built-ins go down first: a file is the sharper intent and overwrites by naming one.
	for (const [id, content] of Object.entries(builtinPersonas())) {
		cards.set(id, { id, name: id, content });
	}
	// Least specific first, so a later (more specific) directory overwrites.
	for (const directory of personaDirs(options.cwd, options.home).reverse()) {
		const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			if (!entry.isFile() || !entry.name.endsWith(".persona.md")) continue;
			const id = entry.name.slice(0, -".persona.md".length);
			if (id.length === 0) continue;
			let content: string;
			try {
				content = await readFile(join(directory, entry.name), "utf8");
			} catch (error) {
				options.warn?.(`[eta-personas] could not read ${entry.name}: ${String(error)}`);
				continue;
			}
			// An empty card is a card that would inject nothing: absent, not broken.
			if (content.trim().length === 0) {
				options.warn?.(`[eta-personas] ${entry.name} is empty; ignoring it`);
				continue;
			}
			cards.set(id, { id, name: id, content });
		}
	}
	return cards;
}

/** The one-line summary a picker (or a model choosing a card) reads. */
export function describeCard(card: PersonaCard): string {
	for (const line of card.content.split("\n")) {
		const clean = line
			.replace(/^#+\s*/, "")
			.replace(/^>\s*/, "")
			.trim();
		if (clean.length > 0) return clean.length > 140 ? `${clean.slice(0, 140)}…` : clean;
	}
	return "";
}

/** The cards as the summaries a new-session dialog shows. */
export function summarize(cards: Map<string, PersonaCard>): {
	id: string;
	name: string;
	description: string;
	custom: boolean;
}[] {
	const builtin = builtinPersonas();
	return [...cards.values()].map((card) => ({
		id: card.id,
		name: card.name,
		description: describeCard(card),
		// A file that shadows a built-in is custom even though it carries a built-in's name:
		// the badge is about who wrote the words, not what the id is.
		custom: builtin[card.id] !== card.content,
	}));
}

/**
 * Which card a session opens on when its own card is gone.
 *
 * A persona is one file; a session is its whole history. So a deleted card, or an id typed by hand
 * before the built-in cards settled their casing, must not take the session out of the sidebar
 * with it: the lookup widens from exact, to the same id under another case, to the fallback. The
 * caller says out loud when it fell back — a session that quietly changed its persona is worse
 * than one that says it did.
 */
export function resolvePersona(cards: Map<string, PersonaCard>, personaId: string): { id: string; exact: boolean } {
	if (cards.has(personaId)) return { id: personaId, exact: true };
	const wanted = personaId.toLowerCase();
	for (const id of cards.keys()) if (id.toLowerCase() === wanted) return { id, exact: false };
	return { id: FALLBACK_PERSONA, exact: false };
}

/** The card to open on when the model gets no vote: the caller's preference, then the fallback. */
export function fallbackPersona(cards: Map<string, PersonaCard>, preferred?: string): PersonaPick {
	if (preferred !== undefined && cards.has(preferred)) return { id: preferred, source: "preferred" };
	if (cards.has(FALLBACK_PERSONA)) return { id: FALLBACK_PERSONA, source: "fallback" };
	const first = cards.keys().next();
	return { id: first.done === true ? FALLBACK_PERSONA : first.value, source: "fallback" };
}

/** Why a card was chosen, so the host can say when the model did not decide. */
export type PersonaPickSource = "model" | "preferred" | "fallback";

export interface PersonaPick {
	id: string;
	source: PersonaPickSource;
}

/** Room for a thinking model to think and still reach the id. */
export const AUTOPICK_MAX_TOKENS = 1_024;

export const PICKER_SYSTEM_PROMPT =
	"You choose the persona card for a chat that is about to start. Reply with exactly one id from the list and nothing else: no quotes, no punctuation, no sentence.";

function escapeForLiteral(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Which card the answer names.
 *
 * Ids are matched as whole tokens — a card named `Executor` must not be claimed by "execute" — and
 * the earliest mention wins, because a model that hedges between two cards states its pick first.
 * `undefined` when nothing on the list appears, which is a fallback rather than a guess.
 */
export function parsePersonaAnswer(text: string, ids: readonly string[]): string | undefined {
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

/** What an autopick needs from the model layer: one call, and the identity to make it with. */
export interface AutopickModel {
	/** The identity of the model a session will run on, resolved by the caller. */
	identity: { provider: string; modelId: string };
	/** One call, without tools. */
	complete(request: { systemPrompt: string; userText: string; maxTokens: number }): Promise<string | undefined>;
}

/**
 * The card a chat with no picked persona opens on.
 *
 * With nothing to ask there is no request at all — the fast path matters because this runs on the
 * path where a person pressed send.
 */
export async function suggestPersonaId(input: {
	cards: Map<string, PersonaCard>;
	prompt: string;
	model?: AutopickModel | undefined;
	preferredId?: string | undefined;
	/** How long the model gets before the fallback answers. */
	timeoutMs?: number | undefined;
}): Promise<PersonaPick> {
	const fallback = fallbackPersona(input.cards, input.preferredId);
	const prompt = input.prompt.trim();
	if (prompt.length === 0 || input.model === undefined || input.cards.size === 0) return fallback;
	const ids = [...input.cards.keys()];
	const menu = ids.map((id) => `- ${id}: ${describeCard(input.cards.get(id) as PersonaCard)}`).join("\n");
	const answered = await withTimeout(
		input.model
			.complete({
				systemPrompt: PICKER_SYSTEM_PROMPT,
				userText: `Persona ids:\n${menu}\n\nFirst message of the chat:\n${prompt.slice(0, 1_200)}`,
				maxTokens: AUTOPICK_MAX_TOKENS,
			})
			.catch(() => undefined),
		input.timeoutMs ?? 30_000,
	);
	if (answered === undefined) return fallback;
	const picked = parsePersonaAnswer(answered, ids);
	return picked === undefined ? fallback : { id: picked, source: "model" };
}

/** Resolve `value`, or `undefined` after `ms`. A pick that takes forever is not a pick. */
async function withTimeout<T>(value: Promise<T>, ms: number): Promise<T | undefined> {
	if (ms <= 0) return undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), ms);
		(timer as { unref?: () => void }).unref?.();
	});
	try {
		return await Promise.race([value, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
