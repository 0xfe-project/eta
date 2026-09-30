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
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { Context } from "cordis";
import { describe, expect, it } from "vitest";
import { sessionsPlugin } from "../src/bundled/sessions";
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
): Promise<Harness> {
	const ctx = new Context();
	const wire = new WireService(ctx);
	const frames: { target?: string; frame: ServerFrame }[] = [];
	wire.attachSink((addressed) => frames.push(addressed));
	const manager = new SessionManager({
		store: new MemorySessionStore(),
		modelsFor: () => models as never,
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
		expect(h.wire.descriptors().map((op) => op.name)).toEqual([
			"sessions.abort",
			"sessions.create",
			"sessions.delete",
			"sessions.focus",
			"sessions.prompt",
			"sessions.resync",
		]);
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
		// only what moved is sent.
		expect(stateFrames().some((entry) => "patch" in entry.frame)).toBe(true);
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
		expect(h.wire.descriptors()).toHaveLength(6);

		await h.unload();
		expect(h.wire.descriptors()).toEqual([]);
		expect(h.wire.registry.hasState("sessions")).toBe(false);
		expect(h.wire.registry.hasState(`sessions.${session}`)).toBe(false);
		// The session itself is untouched: the plugin owned its *wire presence*, not its life.
		expect(h.manager.openSessions()).toHaveLength(1);
		await h.manager.closeAll();
	});
});
