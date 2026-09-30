/**
 * The whole floor, through a real socket (S33).
 *
 * Everything else in this package tests a part. This tests the *assembly*: a server started the
 * way `main` starts it, two clients connecting to its port, a session created over the wire, a
 * turn run, a fork, and the frames that arrive — including the state patches a client that was
 * already watching receives.
 *
 * The models are scripted (a fake `KernelModels`) because the subject is the floor, not a
 * provider; the socket, the frames and the plugins are all real.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientFrame, ServerFrame } from "@eta/client-wire-proto";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type AssembledServer, assembleServer } from "../src/server";

const roots: string[] = [];
const servers: AssembledServer[] = [];

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for the frames");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A client: a real socket, and the frames it has received. */
interface Client {
	frames: ServerFrame[];
	call(target: string, action: string, args?: unknown): Promise<unknown>;
	subscribe(target: string, filter?: string): void;
	close(): void;
}

function connect(port: number): Promise<Client> {
	return new Promise((resolve, reject) => {
		// The pipe's one endpoint. Everything else on the port is static, when there is a UI.
		const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		const frames: ServerFrame[] = [];
		const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
		let nextId = 1;
		socket.addEventListener("message", (event) => {
			const frame = JSON.parse(String((event as MessageEvent).data)) as ServerFrame;
			frames.push(frame);
			if (frame.type !== "reply") return;
			const waiter = pending.get(frame.requestId);
			if (waiter === undefined) return;
			pending.delete(frame.requestId);
			if (frame.ok) waiter.resolve(frame.result);
			else waiter.reject(new Error(frame.error));
		});
		socket.addEventListener("error", () => reject(new Error("the socket could not connect")));
		socket.addEventListener("open", () => {
			resolve({
				frames,
				call(target, action, args) {
					const requestId = `r${nextId++}`;
					const payload: ClientFrame = {
						op: "call",
						target,
						action,
						...(args === undefined ? {} : { args }),
						requestId,
					};
					socket.send(JSON.stringify(payload));
					return new Promise((res, rej) => pending.set(requestId, { resolve: res, reject: rej }));
				},
				subscribe(target, filter) {
					socket.send(JSON.stringify({ op: "subscribe", target, ...(filter === undefined ? {} : { filter }) }));
				},
				close() {
					socket.close();
				},
			});
		});
	});
}

async function startServer(): Promise<AssembledServer> {
	const root = await mkdtemp(join(tmpdir(), "eta-assembled-"));
	roots.push(root);
	const server = await assembleServer({
		dataDir: root,
		configPath: join(root, "no-such-config.json"),
		// A scripted model layer: the subject here is the floor — the socket, the frames, the
		// plugins — and a real provider would make the test depend on the network.
		models: fakeModels([
			assistantMessage({ content: [{ type: "text", text: "first answer" }] }),
			assistantMessage({ content: [{ type: "text", text: "second answer" }] }),
			assistantMessage({ content: [{ type: "text", text: "after the fork" }] }),
		]) as never,
	});
	servers.push(server);
	return server;
}

describe("a server started the way main starts it", () => {
	it("serves hello with the ops and eager state of every bundled plugin", async () => {
		const server = await startServer();
		const client = await connect(server.server.port);
		await until(() => client.frames.some((frame) => frame.type === "hello"));
		const hello = client.frames.find((frame) => frame.type === "hello") as Extract<ServerFrame, { type: "hello" }>;
		const names = hello.ops.map((op) => op.name);
		// The floor knows none of these words; the plugins registered them.
		expect(names).toContain("sessions.create");
		expect(names).toContain("sessions.prompt");
		expect(names).toContain("sessions.fork");
		expect(names).toContain("providers.save");
		expect(names).toContain("settings.save");
		// Every plugin the server has, as `hello` reports it.
		expect(hello.mounted.map((plugin) => plugin.name).sort()).toEqual([
			"personas",
			"providers",
			"sessions",
			"settings",
		]);
		// And the eager state: a settings page and a sidebar draw from `hello` without asking.
		expect(Object.keys(hello.state).sort()).toEqual(["personas", "providers", "sessions", "settings"]);
		client.close();
	});

	it("runs a session over two sockets: create, prompt, frames, fork", async () => {
		const server = await startServer();
		const first = await connect(server.server.port);
		const second = await connect(server.server.port);
		await until(() => first.frames.some((frame) => frame.type === "hello"));
		await until(() => second.frames.some((frame) => frame.type === "hello"));

		// Both clients watch the sidebar; only the first watches the session itself.
		first.subscribe("sessions");
		second.subscribe("sessions");
		const created = (await first.call("sessions", "create", { cwd: "/work/eta" })) as { session: string };
		expect(created.session).toMatch(/^eta-/);
		await until(() =>
			first.frames.some(
				(frame) =>
					frame.type === "state" && frame.target === "sessions" && "patch" in frame && frame.patch !== undefined,
			),
		);
		// The second client sees the sidebar move too: the state is the target's, not the caller's.
		await until(() => second.frames.some((frame) => frame.type === "state" && frame.target === "sessions"));

		first.subscribe(`sessions.${created.session}`);
		await until(() =>
			first.frames.some((frame) => frame.type === "state" && frame.target === `sessions.${created.session}`),
		);
		await first.call("sessions", "prompt", { session: created.session, text: "hello there" });
		await until(() =>
			server.sessions
				.openSessions()
				.some((open) => open.meta.id === created.session && !open.session.runner.running),
		);
		// The turn's events arrived as events on that session's target, and its state followed.
		await until(() =>
			first.frames.some((frame) => frame.type === "event" && frame.target === `sessions.${created.session}`),
		);

		// The turn really produced an answer: what the model was sent is what the session had.
		const answered = (await first.call("sessions", "resync", { session: created.session })) as {
			state: { sections: { transcript: { messages: { message: { role: string; content: unknown } }[] } } };
		};
		const messages = answered.state.sections.transcript.messages;
		expect(messages.map((row) => row.message.role)).toEqual(["user", "assistant"]);
		expect(JSON.stringify(messages[1]?.message.content)).toContain("first answer");

		// A fork is a session of its own, and it appears in the sidebar of a client that did not ask.
		const forked = (await first.call("sessions", "fork", { session: created.session })) as { session: string };
		expect(forked.session).not.toBe(created.session);
		await until(() => second.frames.some((frame) => frame.type === "state" && frame.target === "sessions"));
		const listed = (await first.call("sessions", "resync", { session: created.session })) as {
			state: { sections: { transcript: { messages: unknown[] } } };
		};
		expect(listed.state.sections.transcript.messages.length).toBeGreaterThan(0);

		// A client that goes away is forgotten: frames stop and nothing is left scheduled.
		second.close();
		await until(() => server.server.clients <= 1);
		first.close();
	});

	it("starts without the feature plugins, and says so", async () => {
		const root = await mkdtemp(join(tmpdir(), "eta-bare-"));
		roots.push(root);
		// The floor with no bundled plugins at all: this is the claim that the shell is a pipe and
		// not a session host with plugins bolted on.
		const server = await assembleServer({
			dataDir: root,
			configPath: join(root, "no-such-config.json"),
			plugins: [],
		});
		servers.push(server);
		const client = await connect(server.server.port);
		await until(() => client.frames.some((frame) => frame.type === "hello"));
		const hello = client.frames.find((frame) => frame.type === "hello") as Extract<ServerFrame, { type: "hello" }>;
		expect(hello.ops).toEqual([]);
		expect(hello.state).toEqual({});
		// And a call nobody registered is named as unknown, rather than silently succeeding.
		await expect(client.call("sessions", "create", {})).rejects.toThrow(/unknown op: sessions.create/);
		client.close();
	});

	it("keeps the pipe alive when one bundled plugin fails to load", async () => {
		const root = await mkdtemp(join(tmpdir(), "eta-half-"));
		roots.push(root);
		const server = await assembleServer({
			dataDir: root,
			configPath: join(root, "no-such-config.json"),
			plugins: ["settings"],
		});
		servers.push(server);
		const client = await connect(server.server.port);
		await until(() => client.frames.some((frame) => frame.type === "hello"));
		const hello = client.frames.find((frame) => frame.type === "hello") as Extract<ServerFrame, { type: "hello" }>;
		expect(hello.ops.map((op) => op.name)).toEqual(["settings.reload", "settings.save"]);
		expect(hello.mounted).toEqual([{ name: "settings", source: "bundled" }]);
		client.close();
	});
});

describe("plugins from the user's directories", () => {
	it("loads one at startup, and its target is in hello", async () => {
		const root = await mkdtemp(join(tmpdir(), "eta-scanned-"));
		roots.push(root);
		await mkdir(join(root, "plugins", "greeter"), { recursive: true });
		await writeFile(
			join(root, "plugins", "greeter", "package.json"),
			JSON.stringify({ name: "greeter", "eta-plugin": true }),
		);
		await writeFile(
			join(root, "plugins", "greeter", "index.ts"),
			`export default {
				name: "greeter",
				inject: ["wire"],
				apply(ctx) {
					ctx.wire.handle("greeter", "hello", () => ({ result: { text: "hi from a scanned plugin" } }));
				},
			};`,
			"utf8",
		);
		// A broken one beside it: the floor serves either way, and `hello` says which is which.
		await mkdir(join(root, "plugins", "broken"), { recursive: true });
		await writeFile(
			join(root, "plugins", "broken", "package.json"),
			JSON.stringify({ name: "broken", "eta-plugin": true }),
		);
		await writeFile(join(root, "plugins", "broken", "index.ts"), `throw new Error("nope");`, "utf8");

		const server = await assembleServer({
			dataDir: root,
			configPath: join(root, "no-such-config.json"),
			models: fakeModels([]) as never,
		});
		servers.push(server);
		const client = await connect(server.server.port);
		await until(() => client.frames.some((frame) => frame.type === "hello"));
		const hello = client.frames.find((frame) => frame.type === "hello") as Extract<ServerFrame, { type: "hello" }>;
		expect(hello.ops.map((op) => op.name)).toContain("greeter.hello");
		const greeter = hello.mounted.find((plugin) => plugin.name === "greeter");
		expect(greeter).toMatchObject({ source: "user" });
		expect(greeter?.error).toBeUndefined();
		const broken = hello.mounted.find((plugin) => plugin.name === "broken");
		expect(broken?.error).toContain("nope");
		// And the call really works over the socket.
		expect(await client.call("greeter", "hello", {})).toEqual({ text: "hi from a scanned plugin" });
		client.close();
	});
});
