/**
 * The pipe (S9).
 *
 * Two subjects: the connection rules (ordering, hello, bad frames, replies) against a fake
 * socket, and the Bun binding against a real socket on a loopback port — because "it
 * compiles" is not evidence that a client can connect.
 *
 * The transport knows four words and no feature: what it exposes is whatever the registry
 * holds, which is what the tests register by hand.
 */

import type { ServerFrame, StateSnapshot } from "@eta/client-wire-proto";
import { afterEach, describe, expect, it } from "vitest";
import { createTargetRegistry, type TargetRegistry } from "../src/registry";
import { createStateSender } from "../src/state-sender";
import { createConnection, type Socket, serveWire, type TransportDeps } from "../src/transport";

const SESSIONS_STATE: StateSnapshot = {
	sections: { list: [{ id: "s1" }] },
	revisions: { list: "0" },
};

function harness(overrides: Partial<TransportDeps> = {}) {
	const frames: ServerFrame[] = [];
	const broadcast: ServerFrame[] = [];
	const socket: Socket = { id: 7, send: (frame) => frames.push(frame) };
	const order: string[] = [];
	const registry = createTargetRegistry();
	registry.state("sessions", { project: () => SESSIONS_STATE, eager: true });
	registry.handle("sessions", "prompt", async (call) => {
		order.push(`start:${call.action}`);
		// An op that takes a while: a later op must still wait for it.
		await new Promise((resolve) => setTimeout(resolve, 20));
		order.push(`end:${call.action}`);
		return { result: { queued: true } };
	});
	registry.handle("sessions", "abort", () => {
		order.push("abort");
		return {};
	});
	registry.handle("sessions", "boom", () => {
		throw new Error("nothing to compact");
	});
	const snapshots: Record<string, StateSnapshot> = { sessions: SESSIONS_STATE };
	const state = createStateSender({
		snapshot: (target) => snapshots[target],
		warn: () => undefined,
	});
	const deps: TransportDeps = {
		registry: registry as TargetRegistry,
		state,
		mounted: () => [{ name: "git", source: "bundled" as const }],
		broadcast: (frame) => broadcast.push(frame),
		...overrides,
	};
	return { socket, frames, broadcast, order, registry, state, deps, connection: createConnection(socket, deps) };
}

const hellos = (frames: ServerFrame[]) => frames.filter((frame) => frame.type === "hello");
const replies = (frames: ServerFrame[]) => frames.filter((frame) => frame.type === "reply");

describe("hello", () => {
	it("is the first frame: the ops, the plugins, and the eager state", () => {
		const { frames } = harness();
		expect(frames[0]).toEqual({
			type: "hello",
			ops: [
				{ name: "sessions.abort", target: "sessions", action: "abort" },
				{ name: "sessions.boom", target: "sessions", action: "boom" },
				{ name: "sessions.prompt", target: "sessions", action: "prompt" },
			],
			mounted: [{ name: "git", source: "bundled" }],
			state: { sessions: SESSIONS_STATE },
		});
	});
});

describe("calls", () => {
	it("answers a call that carried a requestId", async () => {
		const { connection, frames } = harness();
		await connection.handle(
			JSON.stringify({ op: "call", target: "sessions", action: "prompt", args: { text: "go" }, requestId: "r1" }),
		);
		expect(replies(frames)).toEqual([{ type: "reply", requestId: "r1", ok: true, result: { queued: true } }]);
	});

	it("stays quiet for a fire-and-forget call", async () => {
		const { connection, frames } = harness();
		await connection.handle(JSON.stringify({ op: "call", target: "sessions", action: "abort" }));
		expect(replies(frames)).toEqual([]);
	});

	it("answers a failure in place when it was asked for, and as an error frame when it was not", async () => {
		const { connection, frames } = harness();
		await connection.handle(JSON.stringify({ op: "call", target: "sessions", action: "boom", requestId: "r2" }));
		expect(replies(frames)).toEqual([{ type: "reply", requestId: "r2", ok: false, error: "nothing to compact" }]);

		await connection.handle(JSON.stringify({ op: "call", target: "sessions", action: "boom" }));
		expect(frames.at(-1)).toEqual({ type: "error", message: "nothing to compact" });
	});

	it("names an unknown call in the failure", async () => {
		const { connection, frames } = harness();
		await connection.handle(JSON.stringify({ op: "call", target: "sessions", action: "promt", requestId: "r3" }));
		expect(replies(frames)).toEqual([
			{ type: "reply", requestId: "r3", ok: false, error: "unknown op: sessions.promt" },
		]);
	});

	it("applies calls from one connection strictly in arrival order", async () => {
		const { connection, order } = harness();
		const first = connection.handle(JSON.stringify({ op: "call", target: "sessions", action: "prompt" }));
		const second = connection.handle(JSON.stringify({ op: "call", target: "sessions", action: "abort" }));
		await Promise.all([first, second]);
		expect(order).toEqual(["start:prompt", "end:prompt", "abort"]);
	});
});

describe("subscriptions", () => {
	it("hands a subscription to the state sender, in place", async () => {
		const { connection, frames, state } = harness();
		await connection.handle(JSON.stringify({ op: "subscribe", target: "sessions" }));
		expect(state.subscriptions(7)).toEqual(["sessions"]);
		// The sender answered, so this socket already has the state.
		expect(frames.at(-1)).toMatchObject({ type: "state", target: "sessions", snapshot: SESSIONS_STATE });

		await connection.handle(JSON.stringify({ op: "unsubscribe", target: "sessions" }));
		expect(state.subscriptions(7)).toEqual([]);
	});
});

describe("frames the pipe sends on its own", () => {
	it("calls a bad frame an error and keeps the connection", async () => {
		const { connection, frames } = harness();
		await connection.handle("{ not json");
		expect(frames.at(-1)).toEqual({ type: "error", message: "bad frame" });
		await connection.handle(JSON.stringify({ op: "call", target: "sessions", action: "abort", requestId: "r4" }));
		expect(frames.at(-1)).toMatchObject({ type: "reply", ok: true });
	});

	it("fans a native frame out as an event on the native target", async () => {
		const { connection, broadcast, frames } = harness();
		const before = frames.length;
		await connection.handle(JSON.stringify({ op: "native", kind: "menu", action: "new-session" }));
		expect(broadcast).toEqual([{ type: "event", target: "native", name: "new-session", data: { kind: "menu" } }]);
		expect(frames.length).toBe(before);
	});

	it("stops sending once the connection is closed, and drops the subscription", () => {
		const { connection, frames, state } = harness();
		void state.subscribe(7, "sessions");
		connection.close();
		connection.send({ type: "error", message: "later" });
		expect(frames.some((frame) => frame.type === "error")).toBe(false);
		expect(state.subscriptions(7)).toEqual([]);
	});
});

describe("the Bun binding", () => {
	let server: { stop(): void } | undefined;
	let client: WebSocket | undefined;

	afterEach(() => {
		client?.close();
		server?.stop();
		server = undefined;
		client = undefined;
	});

	it("serves one endpoint and says hello over a real socket", async () => {
		const { serveWire: serve } = await import("../src/transport");
		const { deps } = harness();
		const wire = serve({ registry: deps.registry, state: deps.state, mounted: deps.mounted }, { port: 0 });
		server = wire;
		expect(wire.port).toBeGreaterThan(0);

		const frames: ServerFrame[] = [];
		client = new WebSocket(`ws://127.0.0.1:${wire.port}/ws`);
		client.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data)) as ServerFrame));
		await new Promise<void>((resolve, reject) => {
			client?.addEventListener("open", () => resolve());
			client?.addEventListener("error", () => reject(new Error("could not connect")));
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(hellos(frames)).toHaveLength(1);
		expect(hellos(frames)[0]?.ops.map((op) => op.name)).toContain("sessions.prompt");

		// A call over the wire comes back as a reply, and a subscription as state.
		client.send(JSON.stringify({ op: "call", target: "sessions", action: "abort", requestId: "r9" }));
		client.send(JSON.stringify({ op: "subscribe", target: "sessions" }));
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(replies(frames)).toContainEqual({ type: "reply", requestId: "r9", ok: true });
		expect(frames.some((frame) => frame.type === "state")).toBe(true);
		expect(wire.clients).toBe(1);

		// A host-pushed frame reaches the client (this is how state and events go out).
		wire.broadcast({ type: "event", target: "dev", name: "tick", data: {} });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(frames.at(-1)).toEqual({ type: "event", target: "dev", name: "tick", data: {} });
	});

	it("answers 404 for anything that is not the socket, or a mounted route", async () => {
		const { deps } = harness();
		const wire = serveWire(
			{ registry: deps.registry, state: deps.state, mounted: deps.mounted },
			{ port: 0, staticRoutes: { "/": () => new Response("ui") } },
		);
		server = wire;
		expect(await (await fetch(`http://127.0.0.1:${wire.port}/`)).text()).toBe("ui");
		expect((await fetch(`http://127.0.0.1:${wire.port}/nope`)).status).toBe(404);
	});
});
