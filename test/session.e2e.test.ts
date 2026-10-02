/**
 * A fully assembled session against a real model (H11).
 *
 * Every piece of the wiring has its own test; this one exists to check the thing
 * those tests cannot: that a session opened the way a host opens one — with an
 * environment, a platform briefing and project memory — is a session a real model can
 * actually work in. The prompt it is given, the tools it may call, and the file it
 * leaves behind are all checked, because "the parts pass" and "the whole works" are
 * different claims.
 *
 * Skipped unless a configuration file is named:
 *
 *   ETA_SMOKE_CONFIG=~/.eta/config.json bun run --cwd packages/eta-harness smoke
 */
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage } from "@eta/core/storage";
import { realModels, selectProvider } from "@eta/core/testing";
import { NodeEnvironment } from "@eta/execution-node";
import { describe, expect, it } from "vitest";
import { envMemoryFs } from "../src/memory";
import { openSession } from "../src/open";

const configPath = process.env.ETA_SMOKE_CONFIG;
const modelSelector = process.env.ETA_SMOKE_MODEL;
const TIMEOUT_MS = Number(process.env.ETA_SMOKE_TIMEOUT_MS ?? 180_000);

describe.skipIf(configPath === undefined)("a real session, assembled the way a host assembles one", () => {
	it(
		"sees its platform and memory, uses a tool, and leaves the file behind",
		async () => {
			const selected = await selectProvider(configPath!, modelSelector);
			const cwd = await mkdtemp(join(tmpdir(), "eta-session-smoke-"));
			const env = new NodeEnvironment({ cwd });
			// A note the session should be able to see without being told where it is.
			await env.writeFile(
				`${cwd}/.eta/MEMORY.md`,
				"# eta memory (untrusted)\n\n## lesson\n\n- [1] answers in this project are verified by reading the file back\n",
			);

			const session = await openSession({
				storage: new MemoryStorage(),
				models: realModels(selected.spec),
				config: { model: { provider: selected.spec.id, modelId: selected.modelId } },
				env,
				platform: {
					cwd,
					home: homedir(),
					configPath: configPath!,
					memoryTarget: `${cwd}/.eta/MEMORY.md`,
					memoryExists: true,
				},
				memory: { fs: envMemoryFs(env), cwd, home: homedir() },
			});

			// What the model is given: the base prompt, the platform briefing about the
			// app's own files, and the note that was already in the project.
			const sections = await session.promptSections();
			expect(sections.sections.map((section) => section.name)).toEqual(["base", "platform", "memory"]);
			// The briefing is written in terms of this session's real paths: the config
			// file it was handed, and where a persona card of its own would go.
			const platform = sections.sections.find((section) => section.name === "platform")?.text ?? "";
			expect(platform).toContain(configPath!);
			expect(platform).toContain(join(homedir(), ".eta", "persona"));
			expect(sections.sections.find((section) => section.name === "memory")?.text).toContain(
				"verified by reading the file back",
			);
			// And the tools it may call are the installed ones, not an empty set.
			expect(session.config.activeToolNames).toContain("write");
			expect(session.config.activeToolNames).toContain("read");

			const word = `POMELO-${Date.now().toString(36)}`;
			session.kernel.inject({
				role: "user",
				content: [
					{
						type: "text",
						text: `Write the exact word ${word} into notes/smoke.txt (create the directory if you need to), then read the file back and reply with only the word you find.`,
					},
				],
				timestamp: Date.now(),
			});
			const result = await session.runner.run();
			expect(result.status).toBe("completed");
			await session.journaling.flush();

			// The file is the hard evidence: the model called a tool, the tool ran on the
			// session's environment, and the bytes are where it said they are.
			const written = await env.readTextFile(`${cwd}/notes/smoke.txt`);
			expect(written.ok).toBe(true);
			expect(written.ok && written.value).toContain(word);
			// And the answer came back through the transcript (the model may phrase it
			// with punctuation, so the word is what is checked).
			const answers = session.log
				.transcript()
				.filter((message) => message.role === "assistant")
				.map((message) => JSON.stringify(message.content))
				.join(" ");
			expect(answers).toContain(word);
			// At least one tool call actually happened: the transcript holds a result.
			expect(session.log.transcript().some((message) => message.role === "toolResult")).toBe(true);

			await session.kernel.dispose();
			session.stop();
			await rm(cwd, { recursive: true, force: true });
		},
		TIMEOUT_MS,
	);
});
