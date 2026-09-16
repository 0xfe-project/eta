import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startNativeBridge } from "../../eta-desktop/src/main/native-bridge.ts";
import { startServer, type EtaServer } from "../src/server.ts";
import { discoverSkillDirs, renderSkillsBlock } from "../src/skills.ts";
import { NodeExecutionEnv } from "@eta/core/node";
import type { ServerMessage } from "../src/protocol.ts";

async function withServer(run: (server: EtaServer) => Promise<void>): Promise<void> {
	const cwd = mkdtempSync(join(tmpdir(), "eta-server-test-"));
	const server = await startServer({
		port: 0,
		cwd,
		webDist: join(cwd, "no-dist"),
		configPath: join(cwd, "no-config.json"),
		dataDir: join(cwd, "sessions"),
	});
	serverCwds.set(server, cwd);
	try {
		await run(server);
	} finally {
		server.close();
	}
}

class SocketReader {
	private readonly messages: ServerMessage[] = [];
	private readonly waiters: {
		resolve(m: ServerMessage): void;
		reject(e: unknown): void;
		timer: ReturnType<typeof setTimeout>;
	}[] = [];

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

async function connect(server: EtaServer, viewPatch = false): Promise<{ socket: WebSocket; reader: SocketReader }> {
	const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws${viewPatch ? "?viewPatch" : ""}`);
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
			writeFileSync(
				join(cwd, ".eta", "persona", "custom.persona.md"),
				"# Custom reviewer card\nReviews with care.\n",
			);
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
			const err = await a.reader.until(
				(m): m is Extract<ServerMessage, { type: "error" }> => "type" in m && m.type === "error",
			);
			expect(err.message).toContain("unknown persona");

			send(a.socket, { op: "session.create", name: "s1", personaId: "Thinker" });
			const created = await a.reader.until(
				(m): m is Extract<ServerMessage, { type: "created" }> => "type" in m && m.type === "created",
			);
			expect(created.name).toBe("s1");

			const b = await connect(server);
			await b.reader.next();
			// second client gets the view frame for the existing session
			await b.reader.until(
				(m): m is Extract<ServerMessage, { channel: "view" }> =>
					"channel" in m && m.channel === "view" && "session" in m && m.session === "s1",
			);

			send(a.socket, { op: "prompt", session: "s1", text: "hello eta" });
			const bView = await b.reader.until(
				(m): m is Extract<ServerMessage, { channel: "view"; view: unknown }> =>
					"channel" in m &&
					m.channel === "view" &&
					"session" in m &&
					m.session === "s1" &&
					// A patch frame carries no transcript; the echo rides the full one.
					"view" in m &&
					JSON.stringify(m.view).includes("[Thinker faux echo]"),
			);
			const painted = JSON.stringify(bView.view);
			expect(painted).toContain("hello eta");
			expect(painted).toContain("[Thinker faux echo] hello eta");

			// dev ring + frames reach both clients equally: dev channel arrived on a
			await a.reader.until(
				(m): m is Extract<ServerMessage, { channel: "dev" }> => "channel" in m && m.channel === "dev",
			);

			send(a.socket, { op: "session.delete", name: "s1" });
			await a.reader.until(
				(m): m is Extract<ServerMessage, { type: "deleted" }> => "type" in m && m.type === "deleted",
			);

			a.socket.close();
			b.socket.close();
		});
	});

	it("creates a chat sent with no persona on the fallback card and runs the prompt", async () => {
		await withServer(async (server) => {
			const a = await connect(server);
			await a.reader.next();
			// No config file in this server, so there is no model to ask and the pick lands on the
			// fallback card — the point is that the send still goes through.
			send(a.socket, { op: "session.create", name: "auto", prompt: "帮我看看这个仓库" });
			const created = await a.reader.until(
				(m): m is Extract<ServerMessage, { type: "created" }> => "type" in m && m.type === "created",
			);
			expect(created.name).toBe("auto");
			const listed = await a.reader.until(
				(m): m is Extract<ServerMessage, { type: "sessions" }> => "type" in m && m.type === "sessions",
			);
			expect(listed.sessions.find((session) => session.name === "auto")?.personas).toEqual(["Thinker"]);
			await a.reader.until(
				(m): m is Extract<ServerMessage, { channel: "view"; view: unknown }> =>
					"channel" in m &&
					m.channel === "view" &&
					"session" in m &&
					m.session === "auto" &&
					"view" in m &&
					JSON.stringify(m.view).includes("[Thinker faux echo]"),
			);
			a.socket.close();
		});
	});

	it("patches wait until every connected tab declared the ability to fold them", async () => {
		await withServer(async (server) => {
			const modern = await connect(server, true);
			await modern.reader.next();
			send(modern.socket, { op: "session.create", name: "cap", personaId: "Thinker" });
			await modern.reader.until(
				(m): m is Extract<ServerMessage, { type: "created" }> => "type" in m && m.type === "created",
			);
			const legacy = await connect(server);
			await legacy.reader.next();
			// A rename moves no transcript, yet while the legacy tab is on the wire
			// the frame must still carry the whole view: it reads view.messages.
			send(legacy.socket, { op: "personaSet", session: "cap", personaId: "Insighter" });
			await modern.reader.until(
				(m): m is Extract<ServerMessage, { channel: "view" }> =>
					"channel" in m && m.channel === "view" && "view" in m,
			);
			legacy.socket.close();
			await new Promise((resolve) => setTimeout(resolve, 50));
			send(modern.socket, { op: "personaSet", session: "cap", personaId: "Thinker" });
			await modern.reader.until(
				(m): m is Extract<ServerMessage, { channel: "view" }> =>
					"channel" in m && m.channel === "view" && "patch" in m && "personas" in m.patch,
			);
			modern.socket.close();
		});
	});

	it("serves older transcript rows from /api/history", async () => {
		await withServer(async (server) => {
			const { socket, reader } = await connect(server);
			await reader.next();
			send(socket, { op: "session.create", name: "hist", personaId: "Thinker" });
			await reader.until(
				(m): m is Extract<ServerMessage, { type: "created" }> => "type" in m && m.type === "created",
			);
			send(socket, { op: "prompt", session: "hist", text: "hello" });
			await reader.until(
				(m): m is Extract<ServerMessage, { channel: "view" }> =>
					"channel" in m &&
					m.channel === "view" &&
					"view" in m &&
					JSON.stringify(m.view).includes("[Thinker faux echo]"),
			);
			const history = (await (
				await fetch(`http://127.0.0.1:${server.port}/api/history?session=hist&before=999999&limit=10`)
			).json()) as { seq: number }[];
			expect(history.length).toBeGreaterThanOrEqual(2);
			socket.close();
		});
	});

	it("stamps a monotonic version on every view frame", async () => {
		await withServer(async (server) => {
			const { socket, reader } = await connect(server, true);
			await reader.next();
			send(socket, { op: "session.create", name: "ver", personaId: "Thinker" });
			await reader.until(
				(m): m is Extract<ServerMessage, { type: "created" }> => "type" in m && m.type === "created",
			);
			const versions: number[] = [];
			for (const personaId of ["Insighter", "Thinker"]) {
				send(socket, { op: "personaSet", session: "ver", personaId });
				const frame = await reader.until(
					(m): m is Extract<ServerMessage, { channel: "view" }> => "channel" in m && m.channel === "view",
				);
				versions.push(frame.version);
			}
			expect(versions[0]).toBeGreaterThanOrEqual(1);
			expect(versions[1]).toBeGreaterThan(versions[0]);
			socket.close();
		});
	});

	it("background runs keep going with zero connected clients", async () => {
		await withServer(async (server) => {
			const a = await connect(server);
			await a.reader.next();
			send(a.socket, { op: "session.create", name: "bg", personaId: "Executor" });
			await a.reader.until(
				(m): m is Extract<ServerMessage, { type: "created" }> => "type" in m && m.type === "created",
			);
			a.socket.close();
			await new Promise((resolve) => setTimeout(resolve, 50));
			const b = await connect(server);
			await b.reader.next();
			const view = await b.reader.until(
				(m): m is Extract<ServerMessage, { channel: "view"; view: unknown }> =>
					"channel" in m && m.channel === "view" && "session" in m && m.session === "bg",
			);
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
			await reader.until(
				(m): m is Extract<ServerMessage, { type: "created" }> => "type" in m && m.type === "created",
			);
			send(socket, { op: "session.rename", session: "ops-1", title: "Renamed" });
			send(socket, { op: "session.pin", session: "ops-1", pinned: true });
			send(socket, { op: "personaSet", session: "ops-1", personaId: "Insighter" });
			const sessions = await reader.until(
				(m): m is Extract<ServerMessage, { type: "sessions" }> =>
					"type" in m &&
					m.type === "sessions" &&
					m.sessions.some((row) => row.name === "ops-1" && row.title === "Renamed" && row.pinned === true),
			);
			const row = sessions.sessions.find((candidate) => candidate.name === "ops-1");
			expect(typeof row?.updated).toBe("number");
			expect(typeof row?.cwd).toBe("string");
			await reader.until(
				(m): m is Extract<ServerMessage, { channel: "view" }> =>
					"channel" in m &&
					m.channel === "view" &&
					"session" in m &&
					m.session === "ops-1" &&
					// The pacer answers an op with a patch frame whenever the transcript
					// did not move; the personas ride along in either frame shape.
					("view" in m ? m.view : m.patch).personas.includes("Insighter"),
			);
			socket.close();
		});
	});
});

describe("queue ops", () => {
	it("answers queueRemove with the lane's outcome", async () => {
		await withServer(async (server) => {
			const { socket, reader } = await connect(server);
			await reader.next();
			send(socket, { op: "session.create", name: "q-1", personaId: "Thinker" });
			await reader.until((m): m is Extract<ServerMessage, { type: "created" }> => "type" in m && m.type === "created");
			// Nothing was waiting, so the honest answer is `not_found`. What is being
			// asserted is the answer itself: the chip leaves the screen either way, and
			// the front end only re-injects or hands back text on `cancelled`.
			send(socket, { op: "queueRemove", session: "q-1", entryId: "absent" });
			const ack = await reader.until(
				(m): m is Extract<ServerMessage, { type: "queueAck" }> => "type" in m && m.type === "queueAck",
			);
			expect(ack).toEqual({ type: "queueAck", session: "q-1", entryId: "absent", outcome: "not_found" });
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

describe("desktop native endpoints", () => {
	it("keeps native capabilities window-local and requires their own credential", async () => {
		const picked: unknown[] = [];
		const bridge = startNativeBridge({
			async folderDialog(input) { picked.push(input); return "/workspace"; },
			async saveFile() { return "/export"; },
			contextMenu() {},
		}, "test");
		try {
			for (const origin of ["null", "views://eta", "http://localhost:5173"]) {
				const url = `${bridge.apiBase}/api/native/folder-dialog`;
				const preflight = await fetch(url, { method: "OPTIONS", headers: { origin } });
				expect(preflight.status).toBe(204);
				for (const token of ["backend-token", bridge.token]) {
					const response = await fetch(url, {
						method: "POST", headers: { origin, authorization: `Bearer ${token}`, "content-type": "application/json" },
						body: JSON.stringify({ startingFolder: "/start" }),
					});
					expect(response.status).toBe(token === bridge.token ? 200 : 401);
					if (response.ok) expect(await response.json()).toEqual({ path: "/workspace" });
				}
			}
			expect(picked).toHaveLength(3);
			expect((await fetch(`${bridge.apiBase}/api/native/info`, { headers: { origin: "https://untrusted.example", authorization: `Bearer ${bridge.token}` } })).status).toBe(403);
			expect((await fetch(`${bridge.apiBase}/api/sessions`, { headers: { authorization: `Bearer ${bridge.token}` } })).status).toBe(404);
		} finally { bridge.close(); }
	});

	it("serves /api/native/*, stamps CORS, and broadcasts push()", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "eta-native-"));
		const server = await startServer({
			port: 0,
			cwd,
			webDist: join(cwd, "no-dist"),
			configPath: join(cwd, "no-config.json"),
			dataDir: join(cwd, "sessions"),
			native: {
				folderDialog: async () => "/picked",
				saveFile: async () => "/saved",
				contextMenu: () => {},
			},
			platform: "darwin",
			appVersion: "9.9.9",
		});
		try {
			const base = `http://127.0.0.1:${server.port}`;
			const info = (await (await fetch(`${base}/api/native/info`)).json()) as {
				isDesktop: boolean;
				platform: string;
				appVersion: string;
			};
			expect(info).toEqual({ isDesktop: true, platform: "darwin", appVersion: "9.9.9" });
			const folder = (await (
				await fetch(`${base}/api/native/folder-dialog`, {
					method: "POST",
					body: "{}",
					headers: { "content-type": "application/json" },
				})
			).json()) as { path: string | null };
			expect(folder).toEqual({ path: "/picked" });

			const health = await fetch(`${base}/api/health`);
			expect(health.headers.get("access-control-allow-origin")).toBe("*");
			expect(health.headers.get("access-control-allow-methods")).toBe("*");

			const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
			const reader = new SocketReader(socket);
			await new Promise<void>((resolve, reject) => {
				socket.addEventListener("open", () => resolve(), { once: true });
				socket.addEventListener("error", () => reject(new Error("ws error")), { once: true });
			});
			await reader.next();
			server.push({ type: "native", kind: "menu", action: "view.toggle-sidebar" });
			const frame = await reader.until(
				(m): m is Extract<ServerMessage, { type: "native" }> => "type" in m && m.type === "native",
			);
			expect(frame.action).toBe("view.toggle-sidebar");
			socket.close();
		} finally {
			server.close();
		}
	});
});

describe("btw handoff", () => {
	// The thread is filled with `btwAnswer` so the test does not depend on a model:
	// what is under test is that handing off starts a main run carrying the thread.
	it("kicks a run carrying the thread when the lane is idle", async () => {
		await withServer(async (server) => {
			const { socket, reader } = await connect(server);
			await reader.next();
			send(socket, { op: "session.create", name: "s1", personaId: "Thinker" });
			await reader.until((m): m is Extract<ServerMessage, { type: "created" }> => "type" in m && m.type === "created");
			send(socket, { op: "btwOpen", session: "s1", kind: "tangent" });
			send(socket, {
				op: "btwAnswer",
				session: "s1",
				threadId: "btw-1",
				question: "which editor?",
				answer: "the one you already know",
			});
			send(socket, { op: "btwHandoff", session: "s1", threadId: "btw-1" });
			const frame = await reader.until(
				(m): m is Extract<ServerMessage, { channel: "view" }> =>
					"channel" in m && m.channel === "view" && JSON.stringify(m).includes("notes taken beside the run"),
				8000,
			);
			// A patch frame carries no transcript, so assert on whatever the frame holds.
			expect(JSON.stringify(frame)).toContain("which editor? -> the one you already know");
			socket.close();
		});
	});

	// The op has to reach a model and come back through the view: with no provider in
	// the test config, the session falls back to the built-in echo model, which answers
	// in a way the frame can be recognized by. The wait and the answer both belong to the
	// thread, so nothing here needs the main lane to be idle.
	it("asks the session's model and answers on the thread", async () => {
		await withServer(async (server) => {
			const { socket, reader } = await connect(server);
			await reader.next();
			send(socket, { op: "session.create", name: "s1", personaId: "Thinker" });
			await reader.until((m): m is Extract<ServerMessage, { type: "created" }> => "type" in m && m.type === "created");
			send(socket, { op: "btwOpen", session: "s1", kind: "tangent" });
			send(socket, { op: "btwAsk", session: "s1", threadId: "btw-1", question: "what is 2+2?" });
			const frame = await reader.until(
				(m): m is Extract<ServerMessage, { channel: "view" }> =>
					"channel" in m && m.channel === "view" && JSON.stringify(m).includes("faux echo"),
			);
			expect(JSON.stringify(frame)).toContain("what is 2+2?");
			socket.close();
		});
	});
});

describe("a persisted session whose persona card is gone", () => {
	// A persona is one file; the session is its whole history. Losing the card to a rename or
	// a delete must not quietly take the chat out of the sidebar.
	it("reopens under the closest card it still has", async () => {
		const root = mkdtempSync(join(tmpdir(), "eta-restore-"));
		const persistDir = join(root, "sessions", "eta-old");
		mkdirSync(join(root, "project"), { recursive: true });
		mkdirSync(persistDir, { recursive: true });
		writeFileSync(
			join(persistDir, "meta.json"),
			JSON.stringify({ personaId: "INSIGHTER", cwd: join(root, "project"), createdAt: Date.now() }),
		);
		writeFileSync(
			join(persistDir, "journal.jsonl"),
			`${JSON.stringify({
				w: [
					{
						kind: "entry",
						entry: {
							id: "e1",
							parentId: null,
							type: "message",
							message: { role: "user", content: [{ type: "text", text: "history that must survive" }], timestamp: 1 },
						},
					},
				],
				t: 1,
			})}\n`,
		);
		const server = await startServer({
			port: 0,
			cwd: join(root, "project"),
			webDist: join(root, "no-dist"),
			configPath: join(root, "no-config.json"),
			dataDir: join(root, "sessions"),
		});
		try {
			const sessions = (await (await fetch(`http://127.0.0.1:${server.port}/api/sessions`)).json()) as {
				name: string;
				personas: string[];
			}[];
			const reopened = sessions.find((session) => session.name === "eta-old");
			expect(reopened).toBeDefined();
			// The built-in `Insighter` is the same card under the case the meta never learned.
			expect(reopened?.personas).toEqual(["Insighter"]);
		} finally {
			server.close();
		}
	});
});

describe("the platform briefing reaches a session", () => {
	// The app's own layout is told to the model as a prompt block, and the Context panel
	// lists it by name — the block is only real if it shows up in what the client is shown.
	it("appears in the view's prompt sections", async () => {
		await withServer(async (server) => {
			const { socket, reader } = await connect(server);
			await reader.next();
			send(socket, { op: "session.create", name: "s1", personaId: "Thinker" });
			const frame = await reader.until(
				(m): m is Extract<ServerMessage, { channel: "view" }> =>
					"channel" in m && m.channel === "view" && JSON.stringify(m).includes('"name":"platform"'),
				8000,
			);
			expect(JSON.stringify(frame)).toContain(join(serverCwds.get(server)!, "no-config.json"));
			socket.close();
		});
	});
});
