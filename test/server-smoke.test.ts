/**
 * The whole floor against a real model (S33).
 *
 * Skipped unless a configuration file is named, so the normal suite stays offline:
 *
 *   ETA_SMOKE_CONFIG=~/.eta/config.json bun run --cwd packages/eta-server smoke
 *   ETA_SMOKE_MODEL=provider:model   (defaults to the file's own defaultModel)
 *
 * Nothing about the endpoint is hardcoded: the providers config, the key and the model all come
 * from that file, because what this proves is that the *assembly* works — a config read from
 * disk becomes a model layer, a client over a real socket creates a session, the run streams, the
 * frames arrive, and the session is still there (with its history) after a reopen.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerFrame } from "@eta/client-wire-proto";
import type { KernelModels } from "@eta/core";
import { describe, expect, it } from "vitest";
import { buildModels } from "../src/providers/runtime";
import { ProviderConfigStore } from "../src/providers/store";
import { assembleServer } from "../src/server";

const configPath = process.env.ETA_SMOKE_CONFIG;
const modelSelector = process.env.ETA_SMOKE_MODEL;
const TIMEOUT_MS = Number(process.env.ETA_SMOKE_TIMEOUT_MS ?? 180_000);

/** A client on a real socket, with the frames it has seen. */
function connect(port: number): Promise<{
	frames: ServerFrame[];
	call: (t: string, a: string, args?: unknown) => Promise<unknown>;
	subscribe: (t: string) => void;
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
			if (frame.type === "error") {
				for (const waiter of pending.values()) waiter.reject(new Error(frame.message));
				pending.clear();
				return;
			}
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

async function until(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe.skipIf(configPath === undefined)("the assembled server, with a real model", () => {
	it(
		"creates a session over the wire, runs a real turn, and finds it again after a restart",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "eta-server-smoke-"));
			// The smoke reads the *user's* config file, so the providers store points at it rather
			// than at a scratch copy: the point is that the real file works.
			const store = new ProviderConfigStore({ path: configPath! });
			const { config } = await store.read();
			const built = await buildModels(config.providers ?? []);
			expect(built.failed).toEqual([]);
			const models = built.models as unknown as KernelModels;
			expect(models).toBeDefined();

			const server = await assembleServer({
				dataDir: root,
				configPath: configPath!,
				models,
			});
			const client = await connect(server.server.port);
			await until(() => client.frames.some((frame) => frame.type === "hello"), TIMEOUT_MS);
			const hello = client.frames.find((frame) => frame.type === "hello") as Extract<ServerFrame, { type: "hello" }>;
			expect(hello.ops.length).toBeGreaterThan(0);

			// The session runs on whichever model the caller names, or the config's default.
			const model = modelSelector ?? config.defaultModel;
			const created = (await client.call("sessions", "create", {
				cwd: root,
				...(model === undefined ? {} : { model }),
			})) as { session: string };
			client.subscribe(`sessions.${created.session}`);
			await client.call("sessions", "prompt", {
				session: created.session,
				text: "Reply with exactly the word: eta",
			});
			await until(
				() =>
					server.sessions
						.openSessions()
						.some((open) => open.meta.id === created.session && !open.session.runner.running),
				TIMEOUT_MS,
			);

			// The answer is in the session's own state, and the frames carried the turn.
			const view = (await client.call("sessions", "resync", { session: created.session })) as {
				state: { sections: { transcript: { messages: { message: { role: string } }[] } } };
			};
			const roles = view.state.sections.transcript.messages.map((row) => row.message.role);
			expect(roles).toContain("user");
			expect(roles).toContain("assistant");
			expect(
				client.frames.some((frame) => frame.type === "event" && frame.target === `sessions.${created.session}`),
			).toBe(true);

			// A restart finds it: a new server over the same data directory lists it, opens it, and
			// the history is there — which is the part a live object cannot fake.
			client.close();
			await server.close();
			const restarted = await assembleServer({ dataDir: root, configPath: configPath!, models });
			const listings = await restarted.sessions.list();
			expect(listings.map((listing) => listing.id)).toContain(created.session);
			const reopened = await restarted.sessions.session(created.session);
			expect(reopened?.session.log.transcript().length).toBeGreaterThanOrEqual(2);
			await restarted.close();
			await rm(root, { recursive: true, force: true });
		},
		TIMEOUT_MS,
	);
});
