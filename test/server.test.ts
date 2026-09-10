import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type EtaServer } from "../src/server.ts";
import { discoverSkillDirs, renderSkillsBlock } from "../src/skills.ts";
import { NodeExecutionEnv } from "@eta/core/node";
import type { ServerMessage } from "../src/protocol.ts";

async function withServer(run: (server: EtaServer) => Promise<void>): Promise<void> {
	const cwd = mkdtempSync(join(tmpdir(), "eta-server-test-"));
	const server = await startServer({ port: 0, cwd, webDist: join(cwd, "no-dist"), configPath: join(cwd, "no-config.json"), dataDir: join(cwd, "sessions") });
	serverCwds.set(server, cwd);
	try {
		await run(server);
	} finally {
		server.close();
	}
}

class SocketReader {
	private readonly messages: ServerMessage[] = [];
	private readonly waiters: { resolve(m: ServerMessage): void; reject(e: unknown): void; timer: ReturnType<typeof setTimeout> }[] = [];

	constructor(socket: WebSocket) {
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data)) as ServerMessage;
			const waiter = this.waiters.shift();
			if (waiter !== undefined) {
				clearTimeout(waiter.timer);
				waiter.resolve(message);
				return;
			}
			this.messages.push(message);
		});
	}

	next(timeoutMs = 5000): Promise<ServerMessage> {
		const queued = this.messages.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timeout waiting for ws frame")), timeoutMs);
			this.waiters.push({ resolve, reject, timer });
		});
	}

	async until<T extends ServerMessage>(match: (m: ServerMessage) => m is T, timeoutMs = 5000): Promise<T> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const remaining = deadline - Date.now();
			const message = await this.next(Math.max(remaining, 1));
			if (match(message)) return message;
		}
	}

	get seen(): ServerMessage[] {
		return [...this.messages];
	}
}

async function connect(server: EtaServer): Promise<{ socket: WebSocket; reader: SocketReader }> {
	const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
	const reader = new SocketReader(socket);
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("ws error")), { once: true });
	});
	return { socket, reader };
}

const send = (socket: WebSocket, message: object): void => {
	socket.send(JSON.stringify(message));
};

describe("persona api", () => {
	it("serves built-ins and discovers dropped .persona.md without restart", async () => {
		await withServer(async (server) => {
			const base = await (await fetch(`http://127.0.0.1:${server.port}/api/personas`)).json();
			const ids = (base as { id: string }[]).map((p) => p.id);
			expect(ids).toContain("Thinker");
			expect(ids).toContain("Executor");
			const cwd = serverCwd(server);
			mkdirSync(join(cwd, ".eta", "persona"), { recursive: true });
			writeFileSync(join(cwd, ".eta", "persona", "custom.persona.md"), "# Custom reviewer card\nReviews with care.\n");
			const next = await (await fetch(`http://127.0.0.1:${server.port}/api/personas`)).json();
			const custom = (next as { id: string; description: string }[]).find((p) => p.id === "custom");
			expect(custom?.description).toBe("Custom reviewer card");
		});
	});
});

// startServer records its cwd for /api/personas; expose it via the health of the test tmpdir.
// (we stash the tmpdir on the server object through a module-level map in tests)
const serverCwds = new WeakMap<object, string>();
function serverCwd(server: EtaServer): string {
	const cwd = serverCwds.get(server);
	if (cwd === undefined) throw new Error("no cwd registered");
	return cwd;
}

describe("ws protocol", () => {
	it("hello, create with bad persona errors, create with persona streams frames both ways", async () => {
		await withServer(async (server) => {
			const a = await connect(server);
			const hello = await a.reader.next();
			expect(hello).toMatchObject({ type: "hello", sessions: [] });

			send(a.socket, { op: "session.create", name: "s1", personaId: "nope" });
			const err = await a.reader.until((m): m is Extract<ServerMessage, { type: "error" }> => "type" in m && m.type === "error");
			expect(err.message).toContain("unknown persona");

			send(a.socket, { op: "session.create", name: "s1", personaId: "Thinker" });
			const created = await a.reader.until((m): m is Extract<ServerMessage, { type: "created" }> => "type" in m && m.type === "created");
			expect(created.name).toBe("s1");

			const b = await connect(server);
			await b.reader.next();
			// second client gets the view frame for the existing session
			await b.reader.until((m): m is Extract<ServerMessage, { channel: "view" }> => "channel" in m && m.channel === "view" && "session" in m && m.session === "s1");

			send(a.socket, { op: "prompt", session: "s1", text: "hello eta" });
			const bView = await b.reader.until(
				(m): m is Extract<ServerMessage, { channel: "view" }> =>
					"channel" in m && m.channel === "view" && "session" in m && m.session === "s1" && JSON.stringify(m.view).includes("[Thinker faux echo]"),
			);
			const painted = JSON.stringify(bView.view);
			expect(painted).toContain("hello eta");
			expect(painted).toContain("[Thinker faux echo] hello eta");

			// dev ring + frames reach both clients equally: dev channel arrived on a
			await a.reader.until((m): m is Extract<ServerMessage, { channel: "dev" }> => "channel" in m && m.channel === "dev");

			send(a.socket, { op: "session.delete", name: "s1" });
			await a.reader.until((m): m is Extract<ServerMessage, { type: "deleted" }> => "type" in m && m.type === "deleted");

			a.socket.close();
			b.socket.close();
		});
	});

	it("background runs keep going with zero connected clients", async () => {
		await withServer(async (server) => {
			const a = await connect(server);
			await a.reader.next();
			send(a.socket, { op: "session.create", name: "bg", personaId: "Executor" });
			await a.reader.until((m): m is Extract<ServerMessage, { type: "created" }> => "type" in m && m.type === "created");
			a.socket.close();
			await new Promise((resolve) => setTimeout(resolve, 50));
			const b = await connect(server);
			await b.reader.next();
			const view = await b.reader.until((m): m is Extract<ServerMessage, { channel: "view" }> => "channel" in m && m.channel === "view" && "session" in m && m.session === "bg");
			expect(view.view.personas).toEqual(["Executor"]);
			b.socket.close();
		});
	});
});

describe("sidebar ops", () => {
	it("session.rename, pin and personaSet update the sidebar and view", async () => {
		await withServer(async (server) => {
			const { socket, reader } = await connect(server);
			await reader.next();
			send(socket, { op: "session.create", name: "ops-1", personaId: "Thinker" });
			await reader.until((m): m is Extract<ServerMessage, { type: "created" }> => "type" in m && m.type === "created");
			send(socket, { op: "session.rename", session: "ops-1", title: "Renamed" });
			send(socket, { op: "session.pin", session: "ops-1", pinned: true });
			send(socket, { op: "personaSet", session: "ops-1", personaId: "INSIGHTER" });
			const sessions = await reader.until(
				(m): m is Extract<ServerMessage, { type: "sessions" }> => "type" in m && m.type === "sessions" && m.sessions.some((row) => row.name === "ops-1" && row.title === "Renamed" && row.pinned === true),
			);
			const row = sessions.sessions.find((candidate) => candidate.name === "ops-1");
			expect(typeof row?.updated).toBe("number");
			expect(typeof row?.cwd).toBe("string");
			await reader.until(
				(m): m is Extract<ServerMessage, { channel: "view" }> => "channel" in m && m.channel === "view" && "session" in m && m.session === "ops-1" && "personas" in m.view && m.view.personas.includes("INSIGHTER"),
			);
			socket.close();
		});
	});
});

describe("skill discovery", () => {
	it("walks up from cwd, adds home, git root, and submodule roots, deduped", () => {
		const root = mkdtempSync(join(tmpdir(), "eta-skills-"));
		const nested = join(root, "a", "b");
		mkdirSync(join(nested, ".agents", "skills"), { recursive: true });
		mkdirSync(join(root, ".git"));
		mkdirSync(join(root, ".agents", "skills"), { recursive: true });
		mkdirSync(join(root, "vendor", "lib", ".agents", "skills"), { recursive: true });
		writeFileSync(join(root, ".gitmodules"), '[submodule "vendor/lib"]\n\tpath = vendor/lib\n');
		const dirs = discoverSkillDirs(nested, join(root, "home"));
		expect(dirs).toContain(join(nested, ".agents", "skills"));
		expect(dirs).toContain(join(root, ".agents", "skills"));
		expect(dirs).toContain(join(root, "vendor", "lib", ".agents", "skills"));
		expect(dirs).toContain(join(root, "home", ".agents", "skills"));
		expect(dirs.length).toBe(new Set(dirs).size);
	});

	it("renders the compact <skills> catalog block", async () => {
		const root = mkdtempSync(join(tmpdir(), "eta-skills-render-"));
		const home = join(root, "home");
		const nested = join(root, "a", "b");
		mkdirSync(nested, { recursive: true });
		mkdirSync(join(home, ".agents", "skills", "demo"), { recursive: true });
		writeFileSync(
			join(home, ".agents", "skills", "demo", "SKILL.md"),
			`---\nname: demo\ndescription: "Line one line two ${"x".repeat(150)}"\n---\nbody\n`,
		);
		const env = new NodeExecutionEnv({ cwd: nested });
		const block = await renderSkillsBlock(env, nested, home);
		expect(block.startsWith("<skills>\n")).toBe(true);
		expect(block.endsWith("</skills>"));
		expect(block).toContain("- demo Line one line two");
		expect(block).toContain(join(home, ".agents", "skills", "demo"));
		expect(block.includes("\n")).toBe(true);
		const empty = await renderSkillsBlock(env, mkdtempSync(join(tmpdir(), "eta-skills-empty-")), join(root, "none"));
		expect(empty).toBe("");
	});
});
