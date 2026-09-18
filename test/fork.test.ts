import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host } from "../src/host.ts";
import { applyOp } from "../src/server.ts";

const userTexts = (host: Host, session: string): string[] =>
	(host.viewOf(session)?.messages ?? [])
		.filter((entry) => entry.message.role === "user")
		.map((entry) => {
			const content = (entry.message as { content?: unknown }).content;
			if (typeof content === "string") return content;
			if (Array.isArray(content))
				return content
					.flatMap((block) => {
						const record = block as { type?: string; text?: unknown };
						return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
					})
					.join("");
			return "";
		});

async function until(ready: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!ready()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for the session to move");
		await Bun.sleep(10);
	}
}

/** A host with no config file: the sessions it opens answer on the echo provider. */
async function fixture(run: (host: Host, directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "eta-fork-"));
	const host = new Host({
		configPath: join(directory, "no-config.json"),
		dataDir: join(directory, "sessions"),
		heartbeatMs: 0,
	});
	try {
		await run(host, directory);
	} finally {
		try {
			await host.close();
		} finally {
			for (let attempt = 0; attempt < 8; attempt += 1) {
				try {
					await rm(directory, { recursive: true, force: true });
					break;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 7) throw error;
					await Bun.sleep(25);
				}
			}
		}
	}
}

/** The same host over a config with two models, so a model choice is visible in the view. */
async function twoModelFixture(
	run: (host: Host, directory: string, holdNextAnswer: () => () => void) => Promise<void>,
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "eta-fork-model-"));
	let hold = Promise.resolve();
	const upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as { model: string };
			await hold;
			const chunk = {
				id: "test",
				object: "chat.completion.chunk",
				created: 1,
				model: body.model,
				choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
			};
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	const configPath = join(directory, "config.json");
	await writeFile(
		configPath,
		JSON.stringify({
			providers: [
				{
					id: "local",
					kind: "openai-compatible",
					baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
					apiKey: "test-only",
					models: [
						{ id: "alpha", contextWindow: 128_000 },
						{ id: "beta", contextWindow: 128_000 },
					],
				},
			],
		}),
		"utf8",
	);
	const host = new Host({ configPath, dataDir: join(directory, "sessions"), heartbeatMs: 0 });
	try {
		await run(host, directory, () => {
			let release = () => {};
			hold = new Promise<void>((resolve) => {
				release = resolve;
			});
			return () => release();
		});
	} finally {
		try {
			await host.close();
		} finally {
			upstream.stop(true);
			await rm(directory, { recursive: true, force: true });
		}
	}
}

describe("session fork", () => {
	it("branches at one message: the copy holds that ask and nothing sent after it", async () => {
		await fixture(async (host, directory) => {
			await host.createSession("src", "Thinker", directory);
			host.queue("src", "first ask", "queue");
			await until(() => userTexts(host, "src").length === 1);
			const cut = (host.viewOf("src")?.messages ?? []).find((entry) => entry.message.role === "user")!;

			// The first answer has to be in before the second ask goes out: a follow-up sitting
			// in the lane is a second message that has not been committed yet, and the fork
			// would then be cut against a transcript still being written.
			await until(() => !host.isRunning("src"));
			host.queue("src", "second ask", "queue");
			await until(() => userTexts(host, "src").length === 2);

			const name = await applyOp(host, { op: "session.fork", from: "src", entryId: cut.entryId, name: "branch" });
			expect(name).toBe("branch");
			expect(userTexts(host, "branch")).toEqual(["first ask"]);
			// The parent is untouched — the copy took a past, it did not move one.
			expect(userTexts(host, "src")).toEqual(["first ask", "second ask"]);
			// The card, the folder and the model settings carry over — the branch is the same
			// session, earlier, not a new chat that happens to know the old one's history.
			expect(host.viewOf("branch")?.personas).toContain("Thinker");
			expect(host.viewOf("branch")?.cwd).toBe(directory);
			expect(host.viewOf("branch")?.thinkingLevel).toBe(host.viewOf("src")?.thinkingLevel);
			expect(host.sidebar().map((session) => session.name)).toContain("branch");
		});
	});

	it("refuses an entry that is not on the branch and leaves no half-created session", async () => {
		await fixture(async (host, directory) => {
			await host.createSession("src", "Thinker", directory);
			host.queue("src", "one ask", "queue");
			await until(() => userTexts(host, "src").length === 1);

			await expect(applyOp(host, { op: "session.fork", from: "src", entryId: "not-an-entry", name: "branch" })).rejects.toThrow(
				/is not on source branch/,
			);
			expect(host.sidebar().map((session) => session.name)).not.toContain("branch");
			await expect(stat(join(directory, "sessions", "branch"))).rejects.toThrow();
		});
	});

	it("keeps the model the parent was talking to, not the one a fresh session would pick", async () => {
		// Two configured models and no default: a session started without a model lands on
		// `alpha`, so a branch that lost its lane configuration would say `alpha` too and the
		// difference the fork has to preserve is exactly the one this test can see.
		await twoModelFixture(async (host, directory) => {
			await host.createSession("src", "Thinker", directory, "local:beta");
			host.queue("src", "ask the beta model", "queue");
			await until(() => userTexts(host, "src").length === 1);
			const cut = (host.viewOf("src")?.messages ?? []).find((entry) => entry.message.role === "user")!;

			await applyOp(host, { op: "session.fork", from: "src", entryId: cut.entryId, name: "branch" });
			expect(host.viewOf("src")?.model).toBe("local:beta");
			expect(host.viewOf("branch")?.model).toBe("local:beta");
			// The counterfactual, in the same config: a session that was never told which model
			// to use gets the first one, which is what a lost configuration would have looked like.
			await host.createSession("plain", "Thinker", directory);
			expect(host.viewOf("plain")?.model).toBe("local:alpha");
		});
	});

	it("copies a session that is still answering, and the parent goes on answering", async () => {
		await twoModelFixture(async (host, directory, holdNextAnswer) => {
			await host.createSession("src", "Thinker", directory, "local:beta");
			const release = holdNextAnswer();
			host.queue("src", "a slow question", "queue");
			await until(() => userTexts(host, "src").length === 1 && host.isRunning("src"));

			const cut = (host.viewOf("src")?.messages ?? []).find((entry) => entry.message.role === "user")!;
			await applyOp(host, { op: "session.fork", from: "src", entryId: cut.entryId, name: "branch" });
			// The branch inherits the question, not the answer still being streamed, and it is
			// idle: an in-flight tool call belongs to the run that started it.
			expect(userTexts(host, "branch")).toEqual(["a slow question"]);
			expect(host.sidebar().find((session) => session.name === "branch")?.badges).not.toContain("running");

			release();
			await until(() => !host.isRunning("src"));
			expect(host.viewOf("src")?.messages.some((entry) => entry.message.role === "assistant")).toBe(true);
		});
	});

	it("names the branch after the message it was cut from", async () => {
		await fixture(async (host, directory) => {
			await host.createSession("src", "Thinker", directory);
			host.queue("src", "rewrite the parser", "queue");
			await until(() => userTexts(host, "src").length === 1);
			const cut = (host.viewOf("src")?.messages ?? []).find((entry) => entry.message.role === "user")!;

			await applyOp(host, { op: "session.fork", from: "src", entryId: cut.entryId });
			const named = host.sidebar().find((session) => session.name !== "src");
			// No title is stored on a fork: the sidebar already calls a session by its first
			// message, and the fork's first message is the one it was cut at.
			expect(named?.title).toBe("rewrite the parser");
		});
	});
});
