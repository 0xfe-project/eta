/**
 * Persona discovery and picking (S24).
 *
 * Two directories, one rule about which wins, and one rule about damage: a card that cannot be
 * read is a card that is absent, never a crash. A session must not fail to open because a file in
 * a directory nobody named is malformed.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AutopickModel } from "../src/personas";
import {
	describeCard,
	discoverPersonas,
	FALLBACK_PERSONA,
	fallbackPersona,
	parsePersonaAnswer,
	personaDirs,
	resolvePersona,
	suggestPersonaId,
} from "../src/personas";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<{ home: string; project: string }> {
	const root = await mkdtemp(join(tmpdir(), "eta-personas-"));
	roots.push(root);
	const home = join(root, "home");
	const project = join(root, "project");
	await mkdir(home, { recursive: true });
	await mkdir(project, { recursive: true });
	return { home, project };
}

/** Write a card into a persona directory. */
async function card(directory: string, id: string, body: string): Promise<void> {
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, `${id}.persona.md`), body, "utf8");
}

describe("finding cards", () => {
	it("reads the home cards and the project's, with the project winning a clash", async () => {
		const { home, project } = await scratch();
		const [projectDir, homeDir] = personaDirs(project, home);
		await card(homeDir as string, "Executor", "# Home executor\nDo the work.\n");
		await card(homeDir as string, "Thinker", "# Thinker\nThink first.\n");
		await card(projectDir as string, "Executor", "# This project's executor\nShip it.\n");

		const cards = await discoverPersonas({ cwd: project, home });
		expect([...cards.keys()].sort()).toEqual(["Executor", "Thinker"]);
		// The project said something about `Executor`, so the project's card is the one.
		expect(cards.get("Executor")?.content).toContain("This project's executor");
		expect(describeCard(cards.get("Executor") as never)).toBe("This project's executor");
	});

	it("shows a card the moment it is written, with no restart", async () => {
		const { home, project } = await scratch();
		expect((await discoverPersonas({ cwd: project, home })).size).toBe(0);
		await card(join(home, ".eta", "persona"), "Newcomer", "# Newcomer\nJust arrived.\n");
		expect([...(await discoverPersonas({ cwd: project, home })).keys()]).toEqual(["Newcomer"]);
	});

	it("treats an unreadable or empty card as absent rather than as a failure", async () => {
		const { home, project } = await scratch();
		const dir = join(home, ".eta", "persona");
		await card(dir, "Good", "# Good\nFine.\n");
		await card(dir, "Empty", "   \n");
		// A directory where a card should be: not a card.
		await mkdir(join(dir, "Odd.persona.md"), { recursive: true });
		const warnings: string[] = [];
		const cards = await discoverPersonas({ cwd: project, home, warn: (message) => warnings.push(message) });
		expect([...cards.keys()]).toEqual(["Good"]);
		expect(warnings.some((message) => message.includes("Empty"))).toBe(true);
	});

	it("ignores a file that is not a card", async () => {
		const { home, project } = await scratch();
		const dir = join(home, ".eta", "persona");
		await card(dir, "Real", "# Real\nYes.\n");
		await writeFile(join(dir, "notes.md"), "not a card", "utf8");
		await writeFile(join(dir, ".persona.md"), "no id", "utf8");
		expect([...(await discoverPersonas({ cwd: project, home })).keys()]).toEqual(["Real"]);
	});
});

describe("a session whose card is gone", () => {
	it("folds case, then falls back, and says it was not exact", async () => {
		const { home, project } = await scratch();
		const dir = join(home, ".eta", "persona");
		await card(dir, "Executor", "# Executor\nWork.\n");
		await card(dir, FALLBACK_PERSONA, "# Thinker\nThink.\n");
		const cards = await discoverPersonas({ cwd: project, home });

		expect(resolvePersona(cards, "Executor")).toEqual({ id: "Executor", exact: true });
		// The id was typed by hand before the card settled its casing.
		expect(resolvePersona(cards, "executor")).toEqual({ id: "Executor", exact: false });
		// The card is gone entirely: the session keeps its row, on the fallback.
		expect(resolvePersona(cards, "Deleted")).toEqual({ id: FALLBACK_PERSONA, exact: false });
	});
});

describe("picking one", () => {
	it("takes the caller's preference, else the fallback, else anything", async () => {
		const { home, project } = await scratch();
		const dir = join(home, ".eta", "persona");
		await card(dir, "Executor", "# Executor\nWork.\n");
		await card(dir, FALLBACK_PERSONA, "# Thinker\nThink.\n");
		const cards = await discoverPersonas({ cwd: project, home });
		expect(fallbackPersona(cards, "Executor")).toEqual({ id: "Executor", source: "preferred" });
		expect(fallbackPersona(cards)).toEqual({ id: FALLBACK_PERSONA, source: "fallback" });
		// A preference that is not a card is not honoured silently.
		expect(fallbackPersona(cards, "Ghost")).toEqual({ id: FALLBACK_PERSONA, source: "fallback" });
		// With no cards at all, the fallback's name is still the answer.
		expect(fallbackPersona(new Map())).toEqual({ id: FALLBACK_PERSONA, source: "fallback" });
	});

	it("matches ids as whole tokens, earliest mention first", () => {
		expect(parsePersonaAnswer("Executor", ["Executor", "Thinker"])).toBe("Executor");
		// A hedge states its pick first, so the earliest mention wins.
		expect(parsePersonaAnswer("I would say Thinker, not Executor", ["Executor", "Thinker"])).toBe("Thinker");
		// A card named `Executor` is not claimed by the word "execute".
		expect(parsePersonaAnswer("Let me execute this plan", ["Executor"])).toBeUndefined();
		expect(parsePersonaAnswer("no idea", ["Executor"])).toBeUndefined();
		// Case does not matter, and a longer id at the same position wins.
		expect(parsePersonaAnswer("thinker", ["Thinker"])).toBe("Thinker");
		expect(parsePersonaAnswer("Executor", ["Exec", "Executor"])).toBe("Executor");
	});

	it("asks the model, and takes its answer when it names a card", async () => {
		const { home, project } = await scratch();
		const dir = join(home, ".eta", "persona");
		await card(dir, "Executor", "# Executor\nWork.\n");
		await card(dir, "Thinker", "# Thinker\nThink.\n");
		const cards = await discoverPersonas({ cwd: project, home });
		const asked: string[] = [];
		const picked = await suggestPersonaId({
			cards,
			prompt: "please ship the refactor",
			model: {
				identity: { provider: "fake", modelId: "fake" },
				async complete(request) {
					asked.push(request.userText);
					return "Executor";
				},
			},
		});
		expect(picked).toEqual({ id: "Executor", source: "model" });
		// The model was shown the cards and the message, and nothing else. The summary is the
		// card's first readable line with the markdown stripped: `# Executor` becomes `Executor`.
		expect(asked[0]).toContain("- Executor: Executor");
		expect(asked[0]).toContain("please ship the refactor");
	});

	it("falls back on every failure: no model, a throw, prose, a timeout", async () => {
		const { home, project } = await scratch();
		const dir = join(home, ".eta", "persona");
		await card(dir, "Executor", "# Executor\nWork.\n");
		const cards = await discoverPersonas({ cwd: project, home });
		const model = (answer: string | (() => never)): AutopickModel => ({
			identity: { provider: "fake", modelId: "fake" },
			async complete(): Promise<string | undefined> {
				if (typeof answer === "function") answer();
				return answer as string;
			},
		});

		// No model at all: no request is even attempted.
		expect(await suggestPersonaId({ cards, prompt: "hi" })).toEqual({ id: "Executor", source: "fallback" });
		// A call that throws.
		expect(
			await suggestPersonaId({
				cards,
				prompt: "hi",
				model: model(() => {
					throw new Error("upstream 500");
				}),
			}),
		).toEqual({ id: "Executor", source: "fallback" });
		// Prose where an id belonged.
		expect(await suggestPersonaId({ cards, prompt: "hi", model: model("I think maybe Executor?") })).toEqual({
			id: "Executor",
			source: "model",
		});
		expect(await suggestPersonaId({ cards, prompt: "hi", model: model("I cannot decide") })).toEqual({
			id: "Executor",
			source: "fallback",
		});
		// A call that never comes back.
		expect(
			await suggestPersonaId({
				cards,
				prompt: "hi",
				model: {
					identity: { provider: "fake", modelId: "fake" },
					complete: () => new Promise(() => undefined),
				},
				timeoutMs: 20,
			}),
		).toEqual({ id: "Executor", source: "fallback" });
		// An empty message is not worth a model call.
		let called = false;
		await suggestPersonaId({
			cards,
			prompt: "   ",
			model: {
				identity: { provider: "fake", modelId: "fake" },
				async complete() {
					called = true;
					return "Executor";
				},
			},
		});
		expect(called).toBe(false);
	});
});
