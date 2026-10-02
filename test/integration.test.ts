/**
 * The git plugin in a real server (S31).
 *
 * This is the "plugin absent does not degrade" trial by fire, and it is why the plugin exists as a
 * plugin rather than as a line in the sessions plugin: the server has to be *exactly as good*
 * without it. So the test mounts the real thing — a server whose `modules/` directory holds this
 * package — and checks both ends:
 *
 * - with it, a session's checkout becomes a fact on the `git` target, and a client can read it;
 * - without it, nothing else changes: the session is created, prompted and forked the same way, and
 *   the only difference is that `git.*` is not an op and `git` is not a target.
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerFrame } from "@eta/client-contracts";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { type AssembledServer, assembleServer } from "@eta/server";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, "..");

const roots: string[] = [];
const servers: AssembledServer[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "eta-git-server-"));
	roots.push(root);
	return root;
}

/** A git checkout to work in. */
async function repository(): Promise<string> {
	const root = await scratch();
	const run = async (...args: string[]): Promise<void> => {
		const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe", env: process.env });
		await child.exited;
	};
	await run("init", "-q");
	await run("config", "user.email", "test@example.com");
	await run("config", "user.name", "Test");
	await writeFile(join(root, "file.txt"), "one\n", "utf8");
	await run("add", ".");
	await run("commit", "-qm", "first");
	await run("checkout", "-q", "-b", "trial");
	return root;
}

/** A server whose `modules/` holds this package, as an installed official plugin would. */
async function serverWithGit(options: { install: boolean }): Promise<AssembledServer> {
	const dataDir = await scratch();
	if (options.install) {
		const target = join(dataDir, "modules", "@eta-plugin-git");
		await mkdir(target, { recursive: true });
		// The package as it would be distributed: the manifest and the code.
		await cp(join(pluginRoot, "src"), join(target, "src"), { recursive: true });
		await cp(join(pluginRoot, "package.json"), join(target, "package.json"));
	}
	const server = await assembleServer({
		dataDir,
		configPath: join(dataDir, "no-such-config.json"),
		models: fakeModels([assistantMessage({ content: [{ type: "text", text: "an answer" }] })]) as never,
		pluginWatchIntervalMs: 0,
	});
	servers.push(server);
	return server;
}

function connect(port: number): Promise<{
	frames: ServerFrame[];
	call: (t: string, a: string, args?: unknown) => Promise<unknown>;
	subscribe: (target: string) => void;
	close: () => void;
}> {
	return new Promise((resolve, reject) => {
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
		socket.addEventListener("open", () =>
			resolve({
				frames,
				call(target, action, args) {
					const requestId = `r${nextId++}`;
					socket.send(
						JSON.stringify({ op: "call", target, action, ...(args === undefined ? {} : { args }), requestId }),
					);
					return new Promise((res, rej) => pending.set(requestId, { resolve: res, reject: rej }));
				},
				subscribe(target) {
					socket.send(JSON.stringify({ op: "subscribe", target }));
				},
				close: () => socket.close(),
			}),
		);
	});
}

async function until(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("with the plugin installed", () => {
	it("turns a session's checkout into a fact on its own target", async () => {
		const repo = await repository();
		const server = await serverWithGit({ install: true });
		const client = await connect(server.server.port);
		await until(() => client.frames.some((frame) => frame.type === "hello"));
		const hello = client.frames.find((frame) => frame.type === "hello") as Extract<ServerFrame, { type: "hello" }>;
		// The manifest names the plugin, and that name is its namespace: a package called
		// `@eta/plugin-git` whose target is `git` declares so, rather than forcing a target name no
		// client would want to type.
		expect(hello.mounted.map((plugin) => plugin.name)).toContain("git");
		expect(hello.ops.map((op) => op.name)).toContain("git.status");
		// Eager: a fresh client has the badges from `hello`, before it asks anything.
		expect(Object.keys(hello.state)).toContain("git");

		// Watching the target is what makes its state arrive: an eager target is in `hello`, and
		// everything after that is a frame for whoever asked.
		client.subscribe("git");
		// A session in that checkout: the plugin hears about it and reads it.
		const created = (await client.call("sessions", "create", { cwd: repo })) as { session: string };
		const rows = (): { session: string; branch: string | null }[] => {
			const frame = [...client.frames].reverse().find((entry) => entry.type === "state" && entry.target === "git");
			if (frame === undefined || frame.type !== "state") return [];
			const sections = (frame.snapshot ?? frame.patch)?.sections as {
				sessions?: { session: string; branch: string | null }[];
			};
			return sections?.sessions ?? [];
		};
		await until(() => rows().some((row) => row.session === created.session));
		expect(rows().find((row) => row.session === created.session)?.branch).toBe("trial");

		// And a change in the checkout shows up when the session's run ends (the bus event the
		// sessions plugin announces) — without the plugin ever polling.
		await writeFile(join(repo, "file.txt"), "one\ntwo\n", "utf8");
		await client.call("sessions", "prompt", { session: created.session, text: "do something" });
		await until(() =>
			server.sessions
				.openSessions()
				.some((open) => open.meta.id === created.session && !open.session.runner.running),
		);
		await until(() => rows().find((row) => row.session === created.session) !== undefined);
		const dirty = (await client.call("git", "refresh", { session: created.session, cwd: repo })) as {
			facts: { dirty: number };
		};
		expect(dirty.facts.dirty).toBe(1);
		client.close();
	}, 60_000);
});

describe("without the plugin", () => {
	it("is exactly as good: the same session work, one fewer target", async () => {
		const repo = await repository();
		const server = await serverWithGit({ install: false });
		const client = await connect(server.server.port);
		await until(() => client.frames.some((frame) => frame.type === "hello"));
		const hello = client.frames.find((frame) => frame.type === "hello") as Extract<ServerFrame, { type: "hello" }>;
		// The plugin is simply not there: no op, no target, no mounted entry.
		expect(hello.ops.map((op) => op.name)).not.toContain("git.status");
		expect(Object.keys(hello.state)).not.toContain("git");
		expect(hello.mounted.map((plugin) => plugin.name)).not.toContain("git");

		// And the session work is unchanged: create, prompt, fork, and read the transcript back.
		const created = (await client.call("sessions", "create", { cwd: repo })) as { session: string };
		await client.call("sessions", "prompt", { session: created.session, text: "hello" });
		await until(() =>
			server.sessions
				.openSessions()
				.some((open) => open.meta.id === created.session && !open.session.runner.running),
		);
		const forked = (await client.call("sessions", "fork", { session: created.session })) as { session: string };
		expect(forked.session).not.toBe(created.session);
		const view = (await client.call("sessions", "resync", { session: created.session })) as {
			state: { sections: { transcript: { messages: unknown[] } } };
		};
		expect(view.state.sections.transcript.messages.length).toBeGreaterThanOrEqual(2);
		// The call that only the plugin could answer is named as unknown, which is the honest answer.
		await expect(client.call("git", "status", { session: created.session, cwd: repo })).rejects.toThrow(/unknown op/);
		client.close();
	}, 60_000);
});
