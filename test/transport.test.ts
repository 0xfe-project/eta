/**
 * The transport (S9).
 *
 * Two subjects, tested separately on purpose: the session rules (ordering, hello,
 * resync, bad frames) against a fake socket, and the Bun binding against a real
 * socket on a loopback port — because "it compiles" is not evidence that a client can
 * connect, and a rule that only shows up over a real socket is a rule in the wrong file.
 */

import type { ServerMessage } from "@eta/wire";
import { afterEach, describe, expect, it } from "vitest";
import { createConnection, type Socket, type TransportDeps } from "../src/transport";

const HELLO = {
	type: "hello" as const,
	sessions: [{ id: "s1", badges: [], personas: [] }],
	attach: "s1",
	models: [{ id: "p:m", label: "m" }],
	personas: ["Executor"],
	mounted: [{ name: "git", source: "bundled" as const }],
};

function harness(overrides: Partial<TransportDeps> = {}) {
	const sent: ServerMessage[] = [];
	const applied: string[] = [];
	const broadcast: ServerMessage[] = [];
	const socket: Socket = { id: 7, send: (message) => sent.push(message) };
	const order: string[] = [];
	const deps: TransportDeps = {
		sidebar: () => HELLO.sessions,
		models: () => HELLO.models,
		personas: () => HELLO.personas,
		mounted: () => HELLO.mounted,
		attach: () => HELLO.attach,
		dispatch: async (op) => {
			applied.push(op.op);
			if (op.op === "native")
				return { broadcast: { type: "native", kind: op.kind, action: op.action }, silent: true };
			order.push(`start:${op.op}`);
			// An op that takes a while: a later op must still wait for it.
			if (op.op === "prompt") await new Promise((resolve) => setTimeout(resolve, 20));
			order.push(`end:${op.op}`);
			if (op.op === "session.create") return { created: "s2" };
			if (op.op === "session.delete") return { deleted: op.session };
			return {};
		},
		viewOf: (session) => (session === "s1" ? { version: 3, view: { messages: [] } as never } : undefined),
		rememberView: () => undefined,
		broadcast: (message) => broadcast.push(message),
		...overrides,
	};
	return { socket, sent, applied, broadcast, order, deps, connection: createConnection(socket, deps) };
}

describe("hello", () => {
	it("is the first frame, with everything a client needs to assemble itself", () => {
		const { sent } = harness();
		expect(sent[0]).toEqual(HELLO);
	});
});

describe("op ordering", () => {
	it("applies ops from one connection strictly in arrival order", async () => {
		const { connection, order, applied } = harness();
		// A slow prompt and an abort behind it: the abort must not overtake the prompt.
		const first = connection.handle(JSON.stringify({ op: "prompt", session: "s1", text: "go" }));
		const second = connection.handle(JSON.stringify({ op: "abort", session: "s1" }));
		await Promise.all([first, second]);
		expect(order).toEqual(["start:prompt", "end:prompt", "start:abort", "end:abort"]);
		expect(applied).toEqual(["prompt", "abort"]);
	});

	it("keeps going after a failed op, and tells this client why", async () => {
		const { connection, sent } = harness({
			dispatch: async (op) => {
				if (op.op === "compact") throw new Error("nothing to compact");
				return {};
			},
		});
		await connection.handle(JSON.stringify({ op: "compact", session: "s1" }));
		await connection.handle(JSON.stringify({ op: "focus", session: "s1" }));
		expect(sent).toContainEqual({ type: "error", message: "nothing to compact" });
		// The list came back after the op that worked: a failure is not a dead connection.
		expect(sent.at(-1)).toMatchObject({ type: "sessions" });
	});
});

describe("frames the client gets back", () => {
	it("announces a created and a deleted session, then re-states the list", async () => {
		const { connection, sent } = harness();
		await connection.handle(JSON.stringify({ op: "session.create", cwd: "/w" }));
		expect(sent).toContainEqual({ type: "created", session: "s2" });
		await connection.handle(JSON.stringify({ op: "session.delete", session: "s1" }));
		expect(sent).toContainEqual({ type: "deleted", session: "s1" });
		expect(sent.filter((message) => "type" in message && message.type === "sessions")).toHaveLength(2);
	});

	it("answers a resync on this socket alone and re-points its patch baseline", async () => {
		const remembered: string[] = [];
		const { connection, sent } = harness({
			rememberView: (_socket, session) => remembered.push(session),
			dispatch: async () => {
				throw new Error("a resync is a read, not an op");
			},
		});
		await connection.handle(JSON.stringify({ op: "resync", session: "s1" }));
		expect(sent.at(-1)).toMatchObject({ channel: "view", session: "s1", version: 3 });
		expect(remembered).toEqual(["s1"]);
		// An unknown session is a no-op, not an error frame.
		const before = sent.length;
		await connection.handle(JSON.stringify({ op: "resync", session: "nope" }));
		expect(sent.length).toBe(before);
	});

	it("calls a bad frame an error and keeps the connection", async () => {
		const { connection, sent } = harness();
		await connection.handle("{ not json");
		expect(sent.at(-1)).toEqual({ type: "error", message: "bad frame" });
		await connection.handle(JSON.stringify({ op: "focus", session: "s1" }));
		expect(sent.at(-1)).toMatchObject({ type: "sessions" });
	});

	it("broadcasts what the router asks to broadcast (the shell's menu click)", async () => {
		const { connection, broadcast, sent } = harness();
		const before = sent.length;
		await connection.handle(JSON.stringify({ op: "native", kind: "menu", action: "new-session" }));
		expect(broadcast).toEqual([{ type: "native", kind: "menu", action: "new-session" }]);
		// Nothing went back to this socket alone: the relay is a fan-out.
		expect(sent.length).toBe(before);
	});

	it("routes every message kind through the same seam", async () => {
		// A plugin op and a session op look the same from here: the transport has no
		// special case, because a router that needs one per kind changes per plugin.
		const { connection, applied } = harness();
		await connection.handle(JSON.stringify({ op: "plugin.subscribe", plugin: "git" }));
		await connection.handle(JSON.stringify({ op: "focus", session: "s1" }));
		expect(applied).toEqual(["plugin.subscribe", "focus"]);
	});

	it("stops sending once the connection is closed", () => {
		const { connection, sent } = harness();
		connection.close();
		connection.send({ type: "error", message: "later" });
		expect(sent.some((message) => "type" in message && message.type === "error")).toBe(false);
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

	it("serves one websocket endpoint and says hello over a real socket", async () => {
		const { serveWire } = await import("../src/transport");
		const { deps } = harness();
		const wire = serveWire(deps, { port: 0 });
		server = wire;
		expect(wire.port).toBeGreaterThan(0);

		const frames: ServerMessage[] = [];
		client = new WebSocket(`ws://127.0.0.1:${wire.port}/ws`);
		client.addEventListener("message", (event) => {
			frames.push(JSON.parse(String(event.data)) as ServerMessage);
		});
		await new Promise<void>((resolve, reject) => {
			client?.addEventListener("open", () => resolve());
			client?.addEventListener("error", () => reject(new Error("could not connect")));
		});
		// hello is the first thing out, over the real socket.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(frames[0]).toEqual(HELLO);

		// An op over the wire comes back as its own effects.
		client.send(JSON.stringify({ op: "session.create", cwd: "/w" }));
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(frames).toContainEqual({ type: "created", session: "s2" });
		expect(wire.clients).toBe(1);

		// A host-pushed frame reaches the client (this is how views and agent events go out).
		wire.broadcast({ type: "error", message: "from the host" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(frames.at(-1)).toEqual({ type: "error", message: "from the host" });
	});

	it("answers 404 for anything that is not the socket, or a mounted route", async () => {
		const { serveWire } = await import("../src/transport");
		const wire = serveWire(harness().deps, { port: 0, staticRoutes: { "/": () => new Response("ui") } });
		server = wire;
		expect(await (await fetch(`http://127.0.0.1:${wire.port}/`)).text()).toBe("ui");
		expect((await fetch(`http://127.0.0.1:${wire.port}/nope`)).status).toBe(404);
	});
});
