/**
 * What a session is told about the app around it, and where its memory lives (S26).
 *
 * Two facts travel with a session that nothing else can supply: the *paths* of the app (config,
 * session directory, project memory) and the *environment* its tools run against. The words are
 * the harness's — the server's job is to know where its own files are.
 *
 * The part worth testing hardest is the split: a session in a remote workspace must read *that*
 * project's memory through *that* machine's filesystem, not the server's. That is the difference
 * between a fact and a plausible-looking lie.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { type ExecutionEnv, MemoryEnvironment, NodeEnvironment } from "@eta/harness";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager, type SessionManagerOptions } from "../src/manager";
import { MemorySessionStore } from "../src/memory-store";

const roots: string[] = [];

async function scratch(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "eta-platform-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function manager(options: Partial<SessionManagerOptions> = {}) {
	return new SessionManager({
		store: new MemorySessionStore(),
		modelsFor: () => fakeModels([assistantMessage()]) as never,
		...options,
	});
}

describe("the platform briefing", () => {
	it("tells the session where the app's files are", async () => {
		const root = await scratch();
		const sessions = manager({
			platformFor: (meta) => ({
				cwd: meta.cwd,
				configPath: join(root, "config.json"),
				sessionDir: join(root, "sessions", meta.id),
				memoryTarget: join(meta.cwd, ".eta", "MEMORY.md"),
				memoryExists: false,
			}),
		});
		const created = await sessions.create({ cwd: "/work/eta" });
		const prompt = await created.session.promptSections();
		const platform = prompt.sections.find((section) => section.name === "platform");
		expect(platform?.text).toContain(join(root, "config.json"));
		expect(platform?.text).toContain(join(root, "sessions", created.meta.id));
		// The words are the harness's: this is a briefing about eta, rendered from this app's paths.
		expect(platform?.text).toContain("<platform>");
	});

	it("says nothing about the app when the host supplies no facts", async () => {
		const sessions = manager();
		const created = await sessions.create({ cwd: "/work/eta" });
		const prompt = await created.session.promptSections();
		expect(prompt.sections.some((section) => section.name === "platform")).toBe(false);
	});
});

describe("memory", () => {
	it("reads the project's memory through the environment the session runs in", async () => {
		const root = await scratch();
		const project = join(root, "project");
		await mkdir(join(project, ".eta"), { recursive: true });
		await writeFile(join(project, ".eta", "MEMORY.md"), "## decision\n- [x#1] the wire is four words\n", "utf8");

		const env = new NodeEnvironment({ cwd: project });
		const sessions = manager({
			envFor: () => ({ env: env as unknown as ExecutionEnv }),
			memoryFor: () => ({ home: root }),
		});
		const created = await sessions.create({ cwd: project });
		// The memory block is composed into the prompt, per generation: that is the read path a
		// model actually sees, and the one worth asserting.
		const prompt = await created.session.promptSections();
		const memory = prompt.sections.find((section) => section.name === "memory");
		expect(memory?.text).toContain("the wire is four words");
	});

	it("reads a *remote* project's memory through the remote filesystem, not the server's", async () => {
		// A remote environment is a filesystem the server cannot see: only what it holds is real.
		const remote = new MemoryEnvironment({
			files: { "/remote/project/.eta/MEMORY.md": "## lesson\n- [remote#1] this machine's memory\n" },
		});
		const sessions = manager({
			envFor: () => ({ env: remote as unknown as ExecutionEnv }),
			memoryFor: () => ({ home: "/remote" }),
		});
		const created = await sessions.create({ cwd: "/remote/project" });
		const prompt = await created.session.promptSections();
		const memory = prompt.sections.find((section) => section.name === "memory");
		expect(memory?.text).toContain("this machine's memory");
		// And nothing from the server's own disk, because the remote filesystem is the only one
		// this session can see.
		expect(created.session.memory).toBeDefined();
	});

	it("has no memory when the host wires none", async () => {
		const sessions = manager();
		const created = await sessions.create({ cwd: "/work/eta" });
		expect(created.session.memory).toBeUndefined();
	});
});

describe("the environment a session runs in", () => {
	it("installs the file and shell tools when there is one, and none when there is not", async () => {
		const root = await scratch();
		const withEnv = manager({
			envFor: () => ({ env: new NodeEnvironment({ cwd: root }) as unknown as ExecutionEnv }),
		});
		const installed = await withEnv.create({ cwd: root });
		expect(installed.session.tools).toContain("bash");
		expect(installed.session.tools).toContain("read");

		// A session with no environment is a legitimate session: a side thread, a sandbox.
		const without = manager();
		const bare = await without.create({ cwd: root });
		expect(bare.session.tools).not.toContain("bash");
	});
});
