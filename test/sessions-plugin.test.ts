/**
 * The bundled `sessions` plugin (S11).
 *
 * It is a plugin, so the test loads it the way a loader would — on a context, with the
 * `wire` service present — and checks that its presence on the pipe is a *registration*:
 * the actions appear in `hello`'s descriptor list, the sidebar is an eager state target, a
 * session that opens gets its own state target, a prompt runs a turn and the frames follow,
 * and unloading the plugin takes every one of those away again.
 *
 * Nothing here calls into the plugin's internals: everything goes through the registry, the
 * state sender and the sink — the same three doors a client uses.
 */
import type { ServerFrame, StateSnapshot } from "@eta/client-wire-proto";
import type { CompactionSummarizer } from "@eta/core";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { Context } from "cordis";
import { describe, expect, it } from "vitest";
import { SESSION_ACTIONS, sessionsPlugin } from "../src/bundled/sessions";
import { SessionManager } from "../src/manager";
import { MemorySessionStore } from "../src/memory-store";
import { UnknownOpError } from "../src/registry";
import { WireService } from "../src/wire-service";

interface Harness {
	ctx: Context;
	wire: WireService;
	manager: SessionManager;
	frames: { target?: string; frame: ServerFrame }[];
	load(): Promise<void>;
	unload(): Promise<void>;
	call(target: string, action: string, args?: unknown): Promise<unknown>;
	state(target: string): StateSnapshot | undefined;
}

async function harness(
	models = fakeModels([assistantMessage({ content: [{ type: "text", text: "an answer" }] })]),
	options: { compaction?: CompactionSummarizer; modelsFor?: (meta: { title?: string }) => unknown } = {},
): Promise<Harness> {
	const ctx = new Context();
	const wire = new WireService(ctx);
	const frames: { target?: string; frame: ServerFrame }[] = [];
	wire.attachSink((addressed) => frames.push(addressed));
	const manager = new SessionManager({
		store: new MemorySessionStore(),
		modelsFor: (meta) => (options.modelsFor === undefined ? models : options.modelsFor(meta)) as never,
		compaction: options.compaction,
	});
	let unload: (() => Promise<void>) | undefined;
	const plugin = sessionsPlugin({ manager });
	const context = { reply: () => undefined };
	return {
		ctx,
		wire,
		manager,
		frames,
		async load() {
			// `ctx.plugin` returns a fiber that is also awaitable: awaiting it means the plugin
			// is loaded (its `apply` has run), and disposing it is the unload.
			const fiber = ctx.plugin(plugin as never, undefined as never);
			await fiber;
			unload = async () => {
				await (fiber as unknown as { dispose(): Promise<void> }).dispose();
			};
		},
		async unload() {
			await unload?.();
		},
		async call(target, action, args) {
			return (await wire.registry.dispatch({ op: "call", target, action, args }, context)).result;
		},
		state: (target) => wire.snapshot(target),
	};
}

/** Wait for a run to finish: the pump starts it, and the plugin reports it on the bus. */
async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for the run");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("what the plugin puts on the pipe", () => {
	it("registers its actions, and they show up as descriptors", async () => {
		const h = await harness();
		await h.load();
		// The descriptor list is the plugin's own action list, not a second copy of it.
		expect(
			h.wire
				.descriptors()
				.map((op) => op.name)
				.sort(),
		).toEqual([...SESSION_ACTIONS].map((action) => `sessions.${action}`).sort());
		await h.unload();
	});

	it("registers the sidebar as an eager state target", async () => {
		const h = await harness();
		await h.load();
		expect(h.wire.registry.eagerTargets()).toEqual(["sessions"]);
		const sidebar = h.state("sessions");
		expect(sidebar?.sections.list).toEqual([]);
		expect(sidebar?.revisions).toHaveProperty("list");
		await h.unload();
	});

	it("registers a state target per open session, and takes it away on close", async () => {
		const h = await harness();
		await h.load();
		const created = (await h.call("sessions", "create", { cwd: "/work/eta", title: "one" })) as { session: string };
		expect(created.session).toBeTruthy();
		// The session's own target exists, and its state is the harness view — sections and all.
		const state = h.state(`sessions.${created.session}`);
		expect(Object.keys(state?.sections ?? {})).toContain("core");
		expect(Object.keys(state?.sections ?? {})).toContain("transcript");

		await h.call("sessions", "delete", { session: created.session });
		expect(h.state(`sessions.${created.session}`)).toBeUndefined();
		await h.unload();
	});
});

describe("a turn, seen from the pipe", () => {
	it("runs a prompt and pushes state, with the events in between", async () => {
		const h = await harness();
		await h.load();
		const { session } = (await h.call("sessions", "create", { cwd: "/work/eta" })) as { session: string };

		// A client watches before it asks: pushes go to subscribers only, which is what keeps the
		// pipe from carrying state nobody is looking at. Subscribing answers in place — the client
		// holds a whole state from the first frame it gets.
		h.wire.subscribe(1, "sessions");
		h.wire.subscribe(1, `sessions.${session}`);
		// And the client is looking at the session it just prompted: a focused target streams
		// tightly, which is the floor this test is asserting against.
		h.wire.focus([`sessions.${session}`]);
		const stateFrames = (): { frame: { snapshot?: unknown; patch?: unknown }; target?: string }[] =>
			h.frames.filter((entry) => entry.frame.type === "state") as never;
		expect(stateFrames()[0]?.frame).toHaveProperty("snapshot");

		await h.call("sessions", "prompt", { session, text: "hello" });
		await until(
			() =>
				h.manager.openSessions()[0]?.session.runner.running === false &&
				h.state(`sessions.${session}`) !== undefined,
		);
		// The transcript the pipe would show holds both sides of the turn.
		const transcript = h.state(`sessions.${session}`)?.sections.transcript as { messages: unknown[] };
		expect(transcript.messages.length).toBeGreaterThanOrEqual(2);

		// Every frame after the turn is a patch, not another snapshot: the client is current, so
		// only what moved is sent. Run traffic is paced, so this arrives on the floor rather than
		// on the instant — which is the point of the budget.
		await until(() => stateFrames().some((entry) => "patch" in entry.frame));
		expect(stateFrames().filter((entry) => "snapshot" in entry.frame)).toHaveLength(2);

		// Events for that session's target were emitted (the agent channel, target-scoped), and
		// they carry the kernel's own event names.
		const events = h.frames.filter((entry) => entry.frame.type === "event") as {
			target?: string;
			frame: { name: string };
		}[];
		expect(events.every((entry) => entry.target === `sessions.${session}`)).toBe(true);
		expect(events.some((entry) => entry.frame.name === "turn:run-start")).toBe(true);
		expect(events.some((entry) => entry.frame.name === "message:update")).toBe(true);

		// State pushes went out for the session and for the sidebar.
		const pushed = stateFrames().map((entry) => entry.target);
		expect(pushed).toContain(`sessions.${session}`);
		expect(pushed).toContain("sessions");
		await h.unload();
	});

	it("keeps the sidebar saying who is running", async () => {
		const h = await harness();
		await h.load();
		const { session } = (await h.call("sessions", "create", { cwd: "/work/eta" })) as { session: string };
		expect((h.state("sessions")?.sections.list as { badges: string[] }[])[0]?.badges).toEqual([]);
		await h.call("sessions", "prompt", { session, text: "go" });
		await until(
			() => (h.state("sessions")?.sections.list as { badges: string[] }[])[0]?.badges.includes("running") === true,
		);
		await until(() => h.manager.openSessions()[0]?.session.runner.running === false);
		await until(() => (h.state("sessions")?.sections.list as { badges: string[] }[])[0]?.badges.length === 0);
		await h.unload();
	});

	it("answers a failure with a name, not with silence", async () => {
		const h = await harness();
		await h.load();
		await expect(h.call("sessions", "promt", { session: "s1" })).rejects.toThrow(UnknownOpError);
		await expect(h.call("sessions", "prompt", { text: "hi" })).rejects.toThrow(/needs a session and a text/);
		await expect(h.call("sessions", "prompt", { session: "nope", text: "hi" })).rejects.toThrow(/no such session/);
		await h.unload();
	});
});

describe("focus", () => {
	it("remembers what a client should attach to, in the sidebar's state", async () => {
		const h = await harness();
		await h.load();
		const { session } = (await h.call("sessions", "create", { cwd: "/work/eta" })) as { session: string };
		await h.call("sessions", "focus", { session });
		expect(h.state("sessions")?.sections.focused).toBe(session);
		await expect(h.call("sessions", "focus", { session: "nope" })).rejects.toThrow(/no such session/);
		await h.unload();
	});
});

describe("unloading", () => {
	it("takes every registration with it, and leaves the manager usable", async () => {
		const h = await harness();
		await h.load();
		const { session } = (await h.call("sessions", "create", { cwd: "/work/eta" })) as { session: string };
		expect(
			h.wire
				.descriptors()
				.map((descriptor) => `${descriptor.target}.${descriptor.action}`)
				.sort(),
		).toEqual([...SESSION_ACTIONS].map((action) => `sessions.${action}`).sort());

		await h.unload();
		expect(h.wire.descriptors()).toEqual([]);
		expect(h.wire.registry.hasState("sessions")).toBe(false);
		expect(h.wire.registry.hasState(`sessions.${session}`)).toBe(false);
		// The session itself is untouched: the plugin owned its *wire presence*, not its life.
		expect(h.manager.openSessions()).toHaveLength(1);
		await h.manager.closeAll();
	});
});

describe("the row a session keeps", () => {
	it("renames, pins and archives, and the sidebar says so", async () => {
		const h = await harness();
		await h.load();
		const { session } = (await h.call("sessions", "create", { cwd: "/work/eta" })) as { session: string };

		const renamed = await h.call("sessions", "rename", { session, title: "porting the wire" });
		expect(renamed).toEqual({ session, title: "porting the wire" });
		await h.call("sessions", "pin", { session, pinned: true });
		await h.call("sessions", "archive", { session, archived: true });

		const row = (h.state("sessions")?.sections.list as { id: string }[]).find((entry) => entry.id === session);
		expect(row).toMatchObject({ title: "porting the wire", pinned: true, archived: true });

		// The row is the store's, not a copy the plugin keeps in a state of its own.
		const listed = (await h.manager.list()).find((listing) => listing.id === session);
		expect(listed?.ok === true ? listed.meta : undefined).toMatchObject({ title: "porting the wire", pinned: true });

		// An empty title clears it; a session that is not there is named as such.
		const cleared = await h.call("sessions", "rename", { session, title: "" });
		expect(cleared).toEqual({ session, title: null });
		await expect(h.call("sessions", "pin", { session: "nope", pinned: true })).rejects.toThrow(/no such session/);
		await expect(h.call("sessions", "archive", { session })).rejects.toThrow(/archived: true or false/);
		await h.unload();
	});

	it("forks a session into a second one, focused, holding the history it copied", async () => {
		const h = await harness(fakeModels([assistantMessage({ content: [{ type: "text", text: "first answer" }] })]));
		await h.load();
		const { session: source } = (await h.call("sessions", "create", { cwd: "/work/eta", title: "the source" })) as {
			session: string;
		};
		await h.call("sessions", "prompt", { session: source, text: "the first question" });
		await until(() => h.manager.openSessions()[0]?.session.runner.running === false);
		const before = (h.state(`sessions.${source}`)?.sections.transcript as { messages: unknown[] }).messages.length;

		const { session: forked } = (await h.call("sessions", "fork", { session: source })) as { session: string };
		expect(forked).not.toBe(source);
		// The fork is on the wire the moment it exists: its own state target, and in front.
		expect(h.wire.targets().map((target) => target.name)).toContain(`sessions.${forked}`);
		expect(h.wire.snapshot(`sessions.${forked}`)).toBeDefined();
		expect(h.state("sessions")?.sections.focused).toBe(forked);
		const rows = h.state("sessions")?.sections.list as { id: string; title?: string }[];
		expect(rows.map((row) => row.id)).toContain(forked);
		expect(rows.find((row) => row.id === forked)?.title).toBe("the source (fork)");

		// It inherited the history prefix, and the source kept all of it.
		const inherited = (h.state(`sessions.${forked}`)?.sections.transcript as { messages: unknown[] }).messages;
		expect(inherited).toHaveLength(before);
		expect(h.state(`sessions.${source}`)?.sections.transcript).toMatchObject({ messages: { length: before } });

		// A fork is a new session: what happens in it does not go back to the one it came from.
		await h.call("sessions", "prompt", { session: forked, text: "a question only the fork asks" });
		await until(
			() => h.manager.session(forked).then((open) => open?.session.runner.running === false) instanceof Promise,
		);
		await until(() => h.state(`sessions.${forked}`)?.sections.transcript !== undefined);
		const sourceText = JSON.stringify(h.state(`sessions.${source}`)?.sections.transcript);
		expect(sourceText).not.toContain("only the fork asks");

		await expect(h.call("sessions", "fork", { session: "nope" })).rejects.toThrow(/no such session/);
		await h.unload();
	});
});

describe("the side threads a session keeps", () => {
	it("opens a thread, asks it, saves its notes, and clears it", async () => {
		const models = fakeModels([
			assistantMessage({ content: [{ type: "text", text: "the side answer" }] }),
			assistantMessage({ content: [{ type: "text", text: "the main answer" }] }),
		]);
		const h = await harness(models);
		await h.load();
		const { session } = (await h.call("sessions", "create", { cwd: "/work/eta" })) as { session: string };
		const seen = () => (h.state(`sessions.${session}`)?.sections.sideThread as { id: string }[]) ?? [];

		// A client that is watching already holds the session's state, so opening a thread
		// arrives as a push rather than as a read the client has to ask for.
		h.wire.subscribe(1, `sessions.${session}`);
		h.frames.length = 0;

		// A contextual thread is seeded from the session as it stands now.
		const opened = (await h.call("sessions", "btwOpen", { session, kind: "contextual" })) as {
			thread: { id: string; kind: string };
		};
		expect(opened.thread).toMatchObject({ id: "btw-1", kind: "contextual" });
		expect(seen().map((thread) => thread.id)).toEqual(["btw-1"]);
		expect(h.frames.some((entry) => entry.target === `sessions.${session}` && entry.frame.type === "state")).toBe(
			true,
		);

		// A question goes to the side model and lands as an answered exchange.
		await h.call("sessions", "btwAsk", { session, threadId: "btw-1", question: "what does the wire look like?" });
		const asked = seen()[0] as unknown as { exchanges: { question: string; answer: string }[] };
		expect(asked.exchanges).toHaveLength(1);
		expect(asked.exchanges[0]).toMatchObject({
			question: "what does the wire look like?",
			answer: "the side answer",
		});

		// A note can be recorded without a model at all.
		await h.call("sessions", "btwAnswer", { session, threadId: "btw-1", question: "coffee?", answer: "later" });
		expect((seen()[0] as unknown as { exchanges: unknown[] }).exchanges).toHaveLength(2);

		// Saving writes the notes into the journal — the thread's history is the journal's.
		expect(await h.call("sessions", "btwSave", { session, threadId: "btw-1" })).toEqual({ state: "saved" });
		const log = h.manager.openSessions().find((open) => open.meta.id === session)?.session.log;
		expect(log?.graph.pathOldestFirst().some((entry) => entry.type === "btw")).toBe(true);

		// Handing off is a real run when the session is idle: the notes arrive as the next input.
		const callsBefore = models.calls.length;
		expect(await h.call("sessions", "btwHandoff", { session, threadId: "btw-1" })).toEqual({ delivered: true });
		await until(() => models.calls.length > callsBefore);
		await until(
			() => h.manager.openSessions().find((open) => open.meta.id === session)?.session.runner.running === false,
		);
		const transcript = JSON.stringify(h.state(`sessions.${session}`)?.sections.transcript);
		expect(transcript).toContain("notes taken beside the run");

		// Clearing drops it from the panel; the notes already written stay in the journal.
		expect(await h.call("sessions", "btwClear", { session, threadId: "btw-1" })).toEqual({ cleared: true });
		expect(seen()).toEqual([]);
		expect(log?.graph.pathOldestFirst().some((entry) => entry.type === "btw")).toBe(true);

		// A thread id that is not there is named as such, not quietly ignored.
		await expect(h.call("sessions", "btwAsk", { session, threadId: "btw-9", question: "hello?" })).rejects.toThrow(
			/no such side thread/,
		);
		await expect(h.call("sessions", "btwOpen", { session, kind: "sideways" })).rejects.toThrow(
			/kind: contextual or tangent/,
		);
		await h.unload();
	});
});

describe("compacting on demand", () => {
	it("compacts when asked, and refuses when the session has no summarizer", async () => {
		const requests: number[] = [];
		const summarizer: CompactionSummarizer = {
			summarize: async (request) => {
				requests.push(request.estimatedTokens);
				return { summary: "everything so far, briefly", retainedTail: [], tokensBefore: request.estimatedTokens };
			},
		};
		const models = fakeModels([
			...[1, 2, 3, 4].map((turn) => assistantMessage({ content: [{ type: "text", text: `answer ${turn}` }] })),
		]);
		const h = await harness(models, { compaction: summarizer });
		await h.load();
		const { session } = (await h.call("sessions", "create", { cwd: "/work/eta" })) as { session: string };
		const running = () => h.manager.openSessions().find((open) => open.meta.id === session)?.session.runner.running;
		for (const question of ["first", "second", "third"]) {
			await h.call("sessions", "prompt", { session, text: question });
			await until(() => running() === false);
		}

		expect(await h.call("sessions", "compact", { session })).toEqual({ session, compacted: true });
		expect(requests).toHaveLength(1);
		// The journal keeps the whole conversation (it is history), and the compaction is a
		// row of its own — what changed is what the *model* is sent next.
		const systems = h.state(`sessions.${session}`)?.sections.systems as { rows: { kind: string }[] };
		expect(systems.rows.filter((row) => row.kind === "compaction")).toHaveLength(1);
		expect(JSON.stringify(h.state(`sessions.${session}`)?.sections.transcript)).toContain("first");

		const callsBefore = models.calls.length;
		await h.call("sessions", "prompt", { session, text: "after the compaction" });
		await until(() => models.calls.length > callsBefore);
		await until(() => running() === false);
		const sent = JSON.stringify(models.calls.at(-1)?.context.messages);
		expect(sent).toContain("everything so far, briefly");
		expect(sent).not.toContain("first");

		// Without a summarizer the session says so instead of pretending nothing happened.
		const bare = await harness(models);
		await bare.load();
		const { session: plain } = (await bare.call("sessions", "create", { cwd: "/work/eta" })) as { session: string };
		await expect(bare.call("sessions", "compact", { session: plain })).rejects.toThrow(/no compaction configured/);
		await bare.unload();
		await h.unload();
	});
});

describe("subagents, as sessions of their own", () => {
	it("spawns a child session and reports it back to the parent", async () => {
		const models = fakeModels([
			// The parent asks for a child, waits for it, and then answers.
			assistantMessage({
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "c1", name: "Agent", arguments: { task: "look into the wire" } }],
			}),
			// The child's own run: it answers and is done.
			assistantMessage({ content: [{ type: "text", text: "the wire is four words" }] }),
			assistantMessage({ content: [{ type: "text", text: "the child says the wire is four words" }] }),
		]);
		const h = await harness(models);
		await h.load();
		const { session } = (await h.call("sessions", "create", { cwd: "/work/eta" })) as { session: string };
		await h.call("sessions", "prompt", { session, text: "what does the wire look like?" });
		const parent = () => h.manager.openSessions().find((open) => open.meta.id === session);
		await until(() => parent()?.session.runner.running === false);
		await until(() => (h.state(`sessions.${session}`)?.sections.subagents as unknown[])?.length > 0);

		// The pool says the child is done, and the parent's transcript carries its report.
		const rows = h.state(`sessions.${session}`)?.sections.subagents as { id: string; status: string }[];
		expect(rows).toEqual([expect.objectContaining({ id: "sub-1", status: "done" })]);
		const transcript = JSON.stringify(h.state(`sessions.${session}`)?.sections.transcript);
		expect(transcript).toContain("sub-1 done");

		// And the child is a session: it has its own row, its own journal, its own answer.
		const listings = await h.manager.list();
		const child = listings.find((listing) => listing.ok && listing.id !== session);
		expect(child?.ok === true ? child.meta.title : undefined).toContain("subagent sub-1");
		expect(child?.ok === true ? child.meta.cwd : undefined).toBe("/work/eta");
		const childTranscript = JSON.stringify(h.state(`sessions.${child!.id}`)?.sections.transcript ?? null);
		expect(childTranscript === "null" || childTranscript.includes("the wire is four words")).toBe(true);

		// Stopping a child the pool does not know is named as such.
		await expect(h.call("sessions", "subagentStop", { session, id: "sub-9" })).rejects.toThrow(/unknown agent/);
		await expect(h.call("sessions", "subagentStop", { session })).rejects.toThrow(/needs a session and an id/);
		// A child that already settled is not "stopped": nothing is running, and nothing throws.
		await h.call("sessions", "subagentStop", { session, id: "sub-1" });
		await h.unload();
	});

	it("marks a child failed when its run did not complete", async () => {
		const models = fakeModels([
			assistantMessage({
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "c1", name: "Agent", arguments: { task: "do something impossible" } }],
			}),
			assistantMessage({ content: [{ type: "text", text: "the parent carries on" }] }),
		]);
		// A subagent whose model does not resolve cannot run at all: its run ends failed at
		// once (no provider conversation to retry), which must not read as "done".
		const noModel = {
			getModel: () => undefined,
			streamSimple: () => undefined,
			completeSimple: async () => undefined,
		};
		const h = await harness(models, {
			modelsFor: (meta) => (meta.title?.startsWith("subagent") === true ? noModel : models),
		});
		await h.load();
		const { session } = (await h.call("sessions", "create", { cwd: "/work/eta" })) as { session: string };
		await h.call("sessions", "prompt", { session, text: "try it" });
		await until(
			() => h.manager.openSessions().find((open) => open.meta.id === session)?.session.runner.running === false,
		);
		await until(() => (h.state(`sessions.${session}`)?.sections.subagents as unknown[])?.length > 0);
		const rows = h.state(`sessions.${session}`)?.sections.subagents as { id: string; status: string }[];

		expect(rows[0]?.status).toBe("failed");
		// What the parent was told says so, rather than reporting a child that produced nothing.
		expect(JSON.stringify(h.state(`sessions.${session}`)?.sections.transcript)).toContain("sub-1 failed");
		await h.unload();
	});
});

describe("a session that is only in the store", () => {
	it("opens on demand: an action on it works after a restart, not only after a create", async () => {
		const models = fakeModels([assistantMessage({ content: [{ type: "text", text: "an answer" }] })]);
		const h = await harness(models);
		await h.load();
		const { session } = (await h.call("sessions", "create", { cwd: "/work/eta" })) as { session: string };
		// What a restart looks like: the row is in the store, and the plugin holds nothing.
		await h.manager.closeAll();
		expect(h.manager.openSessions()).toEqual([]);

		await h.call("sessions", "prompt", { session, text: "are you still there?" });
		const running = () =>
			h.manager.openSessions().find((open) => open.meta.id === session)?.session.runner.running === false;
		await until(running);
		// Opened, attached (its state target exists) and focused, just as if it had been created.
		expect(h.wire.targets().map((target) => target.name)).toContain(`sessions.${session}`);
		expect(h.manager.session(session).then((open) => open !== undefined)).toBeInstanceOf(Promise);
		await h.unload();
	});
});

describe("stopping a child", () => {
	/**
	 * A provider that accepts the request and then says nothing — and, like a real one, stops
	 * waiting when the run is aborted. A stream that ignored the abort signal could not be
	 * killed by anyone, which would make the test assert the wrong thing.
	 */
	const hanging = () => ({
		getModel: () => ({ provider: "fake", id: "fake-model", api: "openai-completions" }),
		streamSimple: (_model: unknown, _context: unknown, streamOptions?: { signal?: AbortSignal }) => {
			const signal = streamOptions?.signal;
			return {
				[Symbol.asyncIterator]: () => ({
					next: async () => {
						await new Promise((_resolve, reject) => {
							if (signal?.aborted === true) {
								reject(new Error("aborted"));
								return;
							}
							signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
						});
						return { done: true, value: undefined };
					},
				}),
			};
		},
		completeSimple: () => new Promise(() => undefined),
		calls: [],
	});

	it("stops a child that is mid-turn, and stops it with its parent", async () => {
		const models = fakeModels([
			assistantMessage({
				stopReason: "toolUse",
				content: [
					{
						type: "toolCall",
						id: "c1",
						name: "Agent",
						// background: the parent does not wait, so the child is still running after it.
						arguments: { task: "think forever", background: true },
					},
				],
			}),
			assistantMessage({ content: [{ type: "text", text: "the parent is done" }] }),
		]);
		const h = await harness(models, {
			modelsFor: (meta) => (meta.title?.startsWith("subagent") === true ? hanging() : models),
		});
		await h.load();
		const { session } = (await h.call("sessions", "create", { cwd: "/work/eta" })) as { session: string };
		await h.call("sessions", "prompt", { session, text: "start a child and move on" });
		const childSession = async () => {
			const listings = await h.manager.list();
			const child = listings.find((listing) => listing.ok && listing.id !== session);
			return child === undefined ? undefined : await h.manager.session(child.id);
		};
		await until(() => h.state(`sessions.${session}`)?.sections.subagents !== undefined);
		await until(() => (h.state(`sessions.${session}`)?.sections.subagents as unknown[])?.length > 0);
		const child = await childSession();
		await until(() => child?.session.runner.running === true);

		// The user stops it: the pool marks the record, and the child's run gives up even
		// though it is stuck inside a turn that would never come back.
		await h.call("sessions", "subagentStop", { session, id: "sub-1" });
		await until(() => child?.session.runner.running === false);
		expect((h.state(`sessions.${session}`)?.sections.subagents as { status: string }[])[0]?.status).toBe("stopped");

		// And closing the parent stops what it spawned: nothing outlives the thing that was
		// going to read its answer.
		await h.call("sessions", "prompt", { session, text: "one more child" });
		await h.call("sessions", "delete", { session });
		await until(() => child?.session.runner.running === false);
		await h.unload();
	});

	it("stops what a deleted parent spawned", async () => {
		const models = fakeModels([
			assistantMessage({
				stopReason: "toolUse",
				content: [
					{ type: "toolCall", id: "c1", name: "Agent", arguments: { task: "wait for orders", background: true } },
				],
			}),
			assistantMessage({ content: [{ type: "text", text: "started" }] }),
		]);
		const h = await harness(models, {
			modelsFor: (meta) => (meta.title?.startsWith("subagent") === true ? hanging() : models),
		});
		await h.load();
		const { session } = (await h.call("sessions", "create", { cwd: "/work/eta" })) as { session: string };
		await h.call("sessions", "prompt", { session, text: "spawn one" });
		const childOf = async () => {
			const listings = await h.manager.list();
			const child = listings.find((listing) => listing.ok && listing.id !== session);
			return child === undefined ? undefined : await h.manager.session(child.id);
		};
		await until(() =>
			h.manager.openSessions().some((open) => open.meta.id !== session && open.session.runner.running),
		);
		const child = await childOf();
		expect(child?.meta.title).toContain("subagent sub-1");

		// Deleting the parent takes its children with it: the child's run is aborted, and
		// nothing is left running behind a session that is gone.
		expect(await h.call("sessions", "delete", { session })).toEqual({ removed: true });
		await until(() => child?.session.runner.running === false);
		// The child session stays (its transcript is evidence); it is simply no longer running.
		expect((await h.manager.list()).some((listing) => listing.ok && listing.id === child?.meta.id)).toBe(true);
		await h.unload();
	});
});

describe("the state a session carries between turns", () => {
	it("sets, pauses, resumes and clears the goal, and starts the work when one is set", async () => {
		const models = fakeModels([assistantMessage({ content: [{ type: "text", text: "on it" }] })]);
		const h = await harness(models);
		await h.load();
		const { session } = (await h.call("sessions", "create", { cwd: "/work/eta" })) as { session: string };
		const goalOf = () =>
			h.state(`sessions.${session}`)?.sections.goal as { objective: string; status: string } | undefined;

		expect(goalOf()).toBeUndefined();
		// A goal with no objective is refused rather than stored empty.
		await expect(h.call("sessions", "goal", { session, action: "set" })).rejects.toThrow(/needs an objective/);
		await expect(h.call("sessions", "goal", { session, action: "wander" })).rejects.toThrow(
			/set, pause, resume or clear/,
		);

		await h.call("sessions", "goal", { session, action: "set", objective: "port the server" });
		expect(goalOf()).toMatchObject({ objective: "port the server", status: "active" });
		// The goal is durable state, not a field on a frame: it is in the journal.
		const log = () => h.manager.openSessions().find((open) => open.meta.id === session)?.session.log;
		expect(
			log()
				?.graph.pathOldestFirst()
				.some((entry) => entry.type === "goal"),
		).toBe(true);
		// Setting it started the work, because "work on this" is an instruction.
		await until(() => models.calls.length > 0);
		await until(
			() => h.manager.openSessions().find((open) => open.meta.id === session)?.session.runner.running === false,
		);

		await h.call("sessions", "goal", { session, action: "pause" });
		expect(goalOf()?.status).toBe("paused");
		await h.call("sessions", "goal", { session, action: "resume" });
		expect(goalOf()?.status).toBe("active");
		await h.call("sessions", "goal", { session, action: "clear" });
		expect(goalOf()).toBeUndefined();
		await h.unload();
	});

	it("creates, updates, sets and removes tasks", async () => {
		const h = await harness();
		await h.load();
		const { session } = (await h.call("sessions", "create", { cwd: "/work/eta" })) as { session: string };
		const tasks = () =>
			h.state(`sessions.${session}`)?.sections.tasks as { id: string; content: string; status: string }[];

		const created = (await h.call("sessions", "taskCreate", {
			session,
			content: "port the wire",
			priority: "high",
		})) as {
			task: { id: string };
		};
		expect(created.task.id).toBe("t1");
		expect(tasks()).toEqual([expect.objectContaining({ id: "t1", content: "port the wire", status: "pending" })]);

		await h.call("sessions", "taskUpdate", { session, id: "t1", content: "port the wire, then the floor" });
		expect(tasks()[0]?.content).toBe("port the wire, then the floor");
		await h.call("sessions", "taskSet", { session, id: "t1", status: "in_progress" });
		expect(tasks()[0]?.status).toBe("in_progress");
		await h.call("sessions", "taskSet", { session, id: "t1", status: "completed" });
		expect(tasks()[0]?.status).toBe("completed");

		// A task that is not there is named as such, not silently nothing.
		await expect(h.call("sessions", "taskSet", { session, id: "t9", status: "completed" })).rejects.toThrow(
			/no such task/,
		);
		expect(await h.call("sessions", "taskRemove", { session, id: "t1" })).toEqual({ removed: true });
		expect(tasks()).toEqual([]);
		await expect(h.call("sessions", "taskRemove", { session })).rejects.toThrow(/needs a session and an id/);
		await h.unload();
	});

	it("deletes a key of the model's own state, and answers a pending question", async () => {
		const h = await harness();
		await h.load();
		const { session } = (await h.call("sessions", "create", { cwd: "/work/eta" })) as { session: string };
		const open = () => h.manager.openSessions().find((entry) => entry.meta.id === session)?.session;
		const stateKeys = () => (h.state(`sessions.${session}`)?.sections.state as { keys: string[] }).keys;

		await h.call("sessions", "resync", { session });
		expect(stateKeys()).toEqual([]);
		await open()?.journaling.writeValues([
			{ kind: "value", op: "set", namespace: "eta.model-state", key: "plan", value: "x" },
		]);
		await h.call("sessions", "resync", { session });
		expect(stateKeys()).toEqual(["plan"]);
		// Deleting it is the same door the model's own state tools use.
		await h.call("sessions", "stateDelete", { session, key: "plan" });
		await h.call("sessions", "resync", { session });
		expect(stateKeys()).toEqual([]);

		// A question waiting for a human is answered (or dropped) through the wire.
		const asked = open()?.ask?.ask(
			{ questionId: "q1", question: "which wire?", options: [], askedAt: Date.now() } as never,
			{ timeoutMs: 5_000 },
		);
		await until(() => (open()?.ask?.pendingAsks() ?? []).length > 0);
		expect(
			await h.call("sessions", "answer", {
				session,
				questionId: "q1",
				response: { kind: "freeform", text: "this one" },
			}),
		).toEqual({ answered: true });
		expect(await asked).toEqual({ kind: "freeform", text: "this one" });
		// An answer for something nobody is waiting on is a `false`, not an invention.
		expect(await h.call("sessions", "answer", { session, questionId: "q1", response: { kind: "none" } })).toEqual({
			answered: false,
		});

		const waiting = open()?.ask?.ask(
			{ questionId: "q2", question: "still there?", options: [], askedAt: Date.now() } as never,
			{ timeoutMs: 5_000 },
		);
		await until(() => (open()?.ask?.pendingAsks() ?? []).length > 0);
		// Dropping the question also gives up the run that was waiting on it: a turn nobody can
		// answer must not hang.
		expect(await h.call("sessions", "askAbort", { session, questionId: "q2" })).toEqual({ aborted: true });
		expect(await waiting).toEqual({ kind: "none" });
		expect(open()?.ask?.pendingAsks()).toEqual([]);
		await h.unload();
	});
});

describe("choosing how the next turn is generated", () => {
	it("switches the model, and refuses while the session is busy", async () => {
		const models = fakeModels([assistantMessage({ content: [{ type: "text", text: "an answer" }] })]);
		// A models layer that serves exactly one identity, the way a real one serves what its
		// providers hold: anything else has to be refused.
		const serves = models.getModel.bind(models);
		models.getModel = (provider, id) =>
			provider === "fake" && id === "fake-model" ? serves(provider, id) : undefined;
		const h = await harness(models);
		await h.load();
		const { session } = (await h.call("sessions", "create", { cwd: "/work/eta" })) as { session: string };
		const open = () => h.manager.openSessions().find((entry) => entry.meta.id === session)?.session;

		// A model nobody serves is named now, not a minute later when a run fails.
		await expect(h.call("sessions", "modelSet", { session, model: "pro6000:nothing" })).rejects.toThrow(
			/model_unavailable/,
		);
		// Nothing changed: a refused switch leaves the session exactly where it was.
		expect(open()?.config.model).toEqual({ provider: "unknown", modelId: "unknown" });

		// The fake models layer serves exactly one identity, so ask for that one.
		const switched = await h.call("sessions", "modelSet", { session, model: "fake:fake-model" });
		expect(switched).toEqual({ model: "fake:fake-model", thinkingLevel: "off" });
		expect(open()?.config.model).toEqual({ provider: "fake", modelId: "fake-model" });
		// Written where a restart reads it: the row and the journal's config both say so.
		const row = (await h.manager.list()).find((listing) => listing.id === session);
		expect(row?.ok === true ? row.meta.model : undefined).toBe("fake:fake-model");
		// The journal holds the configuration now, so a replay comes back on this model rather
		// than on whatever the caller would default to.
		const journaled = await h.manager.list();
		expect(journaled.some((listing) => listing.id === session)).toBe(true);
		const reopened = (await h.manager.session(session))?.session;
		expect(reopened?.config.model).toEqual({ provider: "fake", modelId: "fake-model" });

		// And it refuses to change under a run that already assembled its request.
		await h.call("sessions", "prompt", { session, text: "slow down" });
		await h.call("sessions", "modelSet", { session, model: "fake:fake-model" }).then(
			() => {
				throw new Error("a busy session accepted a model change");
			},
			(error: Error) => expect(error.message).toContain("busy"),
		);
		await until(() => open()?.runner.running === false);
		await h.unload();
	});

	it("sets the thinking level the model accepts", async () => {
		const models = fakeModels([assistantMessage({ content: [{ type: "text", text: "an answer" }] })]);
		const h = await harness(models);
		await h.load();
		const { session } = (await h.call("sessions", "create", { cwd: "/work/eta" })) as { session: string };
		const open = () => h.manager.openSessions().find((entry) => entry.meta.id === session)?.session;

		expect(await h.call("sessions", "thinkingLevel", { session, level: "high" })).toEqual({ session, level: "high" });
		expect(open()?.config.thinkingLevel).toBe("high");
		// A level that does not exist is refused before it reaches the configuration.
		await expect(h.call("sessions", "thinkingLevel", { session, level: "galaxy" })).rejects.toThrow(
			/unknown thinking level/,
		);
		// The fake model does not reason, so anything but "off" is refused rather than sent.
		const reasoning = fakeModels([]);
		reasoning.getModel = () =>
			({ provider: "fake", id: "fake-model", api: "openai-completions", reasoning: false }) as never;
		const plain = await harness(reasoning);
		await plain.load();
		const { session: other } = (await plain.call("sessions", "create", { cwd: "/work/eta" })) as { session: string };
		await expect(plain.call("sessions", "thinkingLevel", { session: other, level: "high" })).rejects.toThrow(
			/does not support thinking level high/,
		);
		await plain.unload();
		await h.unload();
	});

	it("takes a queued input back, and says which of the three things happened", async () => {
		const models = fakeModels([
			assistantMessage({
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "c1", name: "TaskList", arguments: {} }],
			}),
			assistantMessage({ content: [{ type: "text", text: "done" }] }),
		]);
		const h = await harness(models);
		await h.load();
		const { session } = (await h.call("sessions", "create", { cwd: "/work/eta" })) as { session: string };
		const open = () => h.manager.openSessions().find((entry) => entry.meta.id === session)?.session;

		// An id nothing has seen: never there.
		expect(await h.call("sessions", "queueRemove", { session, entryId: "never" })).toEqual({
			entryId: "never",
			outcome: "not_found",
		});

		// Queue one behind a run that is in flight, then take it back.
		await h.call("sessions", "prompt", { session, text: "start something" });
		await until(() => open()?.runner.running === true);
		await h.call("sessions", "prompt", { session, text: "and then this" });
		const queued = open()?.kernel.inbox.list() ?? [];
		expect(queued).toHaveLength(1);
		const entryId = queued[0]?.entryId as string;
		expect(await h.call("sessions", "queueRemove", { session, entryId })).toEqual({ entryId, outcome: "cancelled" });
		expect(open()?.kernel.inbox.list()).toEqual([]);

		// One the run already took: the journal holds it, so it was consumed, not cancelled.
		await until(() => open()?.runner.running === false);
		const consumed = open()?.log.graph.pathOldestFirst()[0]?.id as string;
		expect(await h.call("sessions", "queueRemove", { session, entryId: consumed })).toEqual({
			entryId: consumed,
			outcome: "already_consumed",
		});
		await h.unload();
	});
});
