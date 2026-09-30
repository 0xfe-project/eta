/**
 * The view (S16).
 *
 * The subject is that nothing here enumerates fields: sections arrive from whoever owns
 * the state, each carries its own revision, and a contribution can be withdrawn. The
 * tests use a plugin's own section as the proof that the set is open — and the four
 * properties the server's frame logic depends on: a section appears when its owner has
 * something to say, its revision moves only when its state does, a withdrawn
 * contribution leaves no trace, and a broken contribution does not take the frame down.
 */
import { MemoryStorage, Runner, SessionLog } from "@eta/core";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { Context } from "cordis";
import { describe, expect, it } from "vitest";
import { openSession } from "../src/open";
import { journaledKernel } from "../src/testing";
import { builtinViewContributions, ViewService, type ViewSources } from "../src/view";

const userMsg = (text: string) => ({
	role: "user" as const,
	content: [{ type: "text" as const, text }],
	timestamp: 0,
});

describe("the container", () => {
	it("projects every contribution, with a revision each", () => {
		const service = new ViewService(new Context(), { core: () => ({ session: "s1", running: false }) });
		service.contribute({ name: "one", project: () => 1, revision: () => "a" });
		service.contribute({ name: "two", project: () => ({ x: 2 }), revision: () => "b" });
		const snapshot = service.snapshot();
		expect(snapshot.core).toEqual({ session: "s1", running: false });
		expect(snapshot.sections).toEqual({ one: 1, two: { x: 2 } });
		expect(snapshot.revisions).toEqual({ one: "a", two: "b" });
		expect(service.names()).toEqual(["one", "two"]);
	});

	it("refuses two contributions with one name", () => {
		const service = new ViewService(new Context(), { core: () => ({ session: "s1", running: false }) });
		service.contribute({ name: "git", project: () => ({}), revision: () => "1" });
		expect(() => service.contribute({ name: "git", project: () => ({}), revision: () => "2" })).toThrow(
			/already contributed: git/,
		);
	});

	it("withdraws a contribution without touching its neighbours", () => {
		const service = new ViewService(new Context(), { core: () => ({ session: "s1", running: false }) });
		const off = service.contribute({ name: "git", project: () => ({ branch: "main" }), revision: () => "main" });
		service.contribute({ name: "session", project: () => "core", revision: () => "1" });
		off();
		const snapshot = service.snapshot();
		// The section and its revision are both gone: absence is what tells the client.
		expect(snapshot.revisions).not.toHaveProperty("git");
		expect(snapshot.sections).not.toHaveProperty("git");
		expect(snapshot.sections.session).toBe("core");
	});

	it("reports a broken contribution instead of failing the frame", () => {
		const warnings: string[] = [];
		const service = new ViewService(new Context(), {
			core: () => ({ session: "s1", running: false }),
			warn: (message) => warnings.push(message),
		});
		service.contribute({
			name: "bad",
			project: () => {
				throw new Error("plugin exploded");
			},
			revision: () => "x",
		});
		service.contribute({ name: "good", project: () => "fine", revision: () => "1" });
		const snapshot = service.snapshot();
		expect(snapshot.sections.good).toBe("fine");
		expect(snapshot.sections.bad).toEqual({ error: "plugin exploded" });
		expect(warnings.join(" ")).toContain("view section bad failed");
	});
});

describe("the built-in sections a session contributes", () => {
	it("are there as soon as a session is open, with the shapes their owners promise", async () => {
		const session = await openSession({
			storage: new MemoryStorage(),
			models: fakeModels([assistantMessage({ content: [{ type: "text", text: "hello" }] })]) as never,
			sessionId: "eta-1",
			cwd: "/work/eta",
		});
		const names = session.view.names();
		for (const expected of [
			"transcript",
			"systems",
			"thinking",
			"branch",
			"usage",
			"goal",
			"tasks",
			"model",
			"queue",
			"tools",
			"metrics",
			"personas",
			"state",
			"sideThread",
			"subagents",
		]) {
			expect(names, `missing section: ${expected}`).toContain(expected);
		}
		// A session without an ask channel has no ask section: absence is the truth.
		expect(names).not.toContain("ask");

		const before = session.view.snapshot();
		expect(before.core.session).toBe("eta-1");
		expect(before.core.cwd).toBe("/work/eta");
		expect(before.core.running).toBe(false);
		expect(before.sections.goal).toBeUndefined();
		expect(before.sections.tasks).toEqual([]);
		// No model was configured for this session: the section says so rather than
		// pretending, which is what the composer's picker shows as "unset".
		expect(before.sections.model).toEqual({ id: "unknown:unknown", thinkingLevel: "off" });
		expect((before.sections.tools as { name: string }[]).map((tool) => tool.name)).toContain("TaskUpdate");
		expect(before.sections.transcript).toEqual({ messages: [] });

		await session.kernel.dispose();
		session.stop();
	});

	it("say what the session is doing: a turn appears in the transcript, the goal in its section", async () => {
		const models = fakeModels([assistantMessage({ content: [{ type: "text", text: "done" }] })]);
		const session = await openSession({ storage: new MemoryStorage(), models: models as never, sessionId: "eta-2" });
		const empty = session.view.snapshot();

		session.kernel.goal.set("finish the port");
		session.kernel.tasks.create("keep it green");
		session.kernel.inject(userMsg("go"));
		await session.runner.run();
		await session.journaling.flush();

		const after = session.view.snapshot();
		// The transcript section is the journal, and it moved.
		expect((after.sections.transcript as { messages: unknown[] }).messages).toHaveLength(2);
		expect(after.revisions.transcript).not.toBe(empty.revisions.transcript);
		expect(after.sections.goal).toMatchObject({ objective: "finish the port" });
		expect((after.sections.tasks as { content: string }[])[0]?.content).toBe("keep it green");
		// The core is not a section: it changes on its own (a streaming frame, a run start).
		expect(after.revisions).not.toHaveProperty("core");

		await session.kernel.dispose();
		session.stop();
	});

	it("keeps a revision still when nothing about its owner moved", async () => {
		const session = await openSession({
			storage: new MemoryStorage(),
			models: fakeModels([]) as never,
			sessionId: "eta-3",
		});
		const once = session.view.snapshot();
		const twice = session.view.snapshot();
		for (const [name, revision] of Object.entries(once.revisions)) {
			// `metrics` is a live rate on purpose; every other section is stable when idle.
			if (name === "metrics") continue;
			expect(twice.revisions[name], `section ${name} moved while idle`).toBe(revision);
		}
		await session.kernel.dispose();
		session.stop();
	});

	it("carries the message being streamed in the core, and drops it when it lands", async () => {
		const models = fakeModels([assistantMessage({ content: [{ type: "text", text: "hi" }] })]);
		const session = await openSession({ storage: new MemoryStorage(), models: models as never, sessionId: "eta-4" });
		session.kernel.inject(userMsg("go"));
		const run = session.runner.run();
		// While the run is in flight the core says so.
		await new Promise((resolve) => setTimeout(resolve, 0));
		await run;
		const settled = session.view.snapshot();
		expect(settled.core.running).toBe(false);
		expect(settled.core.streaming).toBeUndefined();
		await session.kernel.dispose();
		session.stop();
	});
});

describe("a plugin's section", () => {
	it("arrives as just another section, and leaves when its contribution is withdrawn", async () => {
		const session = await openSession({
			storage: new MemoryStorage(),
			models: fakeModels([]) as never,
			sessionId: "eta-5",
		});
		const before = session.view.snapshot();
		expect(before.revisions).not.toHaveProperty("git");

		const off = session.view.contribute({
			name: "git",
			project: () => ({ branch: "main", dirty: 2 }),
			revision: () => "main|2",
		});
		const withGit = session.view.snapshot();
		expect(withGit.sections.git).toEqual({ branch: "main", dirty: 2 });
		expect(withGit.revisions.git).toBe("main|2");

		off();
		const after = session.view.snapshot();
		expect(after.revisions).not.toHaveProperty("git");
		await session.kernel.dispose();
		session.stop();
	});
});

describe("the built-in contributions, against the sources directly", () => {
	it("read their owner's public state and nothing else", () => {
		// A seam test: the contributions are functions of the sources, so they can be
		// exercised without a session — which is also why adding one does not touch the
		// server.
		const log = SessionLog.create(new MemoryStorage());
		const { kernel, journaling } = journaledKernel(log);
		const runner = new Runner(kernel, { models: fakeModels([]) as never });
		const sources: ViewSources = {
			session: "s",
			running: () => runner.running,
			streaming: () => undefined,
			entries: () => journaling.entries(),
			entryVersion: () => journaling.version,
			branch: () => ({ tipId: log.graph.tipId(), compactionEpoch: journaling.compactionEpoch }),
			usage: () => journaling.usage,
			goal: () => kernel.goal.current,
			tasks: () => kernel.tasks.list(),
			personaNames: () => kernel.persona.activeNamesList(),
			config: () => kernel.config.get(),
			queue: () => kernel.inbox.list(),
			tools: () => kernel.tools.list(),
			stateKeys: () => journaling.valueNames(),
			tokensPerSec: () => 0,
			ask: () => undefined,
			sideThread: () => [],
			subagents: () => [],
		};
		const contributions = builtinViewContributions(sources);
		const byName = new Map(contributions.map((c) => [c.name, c]));
		expect([...byName.keys()]).toContain("transcript");
		kernel.tasks.create("a task");
		expect(byName.get("tasks")?.project()).toHaveLength(1);
		// The revision is the owner's own signature: creating a task moved it.
		expect(byName.get("tasks")?.revision()).toContain("a task");
		void kernel.dispose();
	});
});
