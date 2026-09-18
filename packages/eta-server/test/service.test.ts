import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { backendRunFile, type BackendDescriptor } from "@eta/core/remote";
import { ensureBackend } from "../src/service-launcher.ts";
import type { ServerMessage } from "../src/protocol.ts";
import { startServer, BackendBusyError } from "../src/server.ts";
import { claimBackend, pidAlive, probeBackend, readDescriptor } from "../src/service.ts";

const TestWebSocket = WebSocket as unknown as { new (url: string, options: { headers: Record<string, string> }): WebSocket };

const homes: string[] = [];
const tmp = (): string => {
	const home = mkdtempSync(join(tmpdir(), "eta-service-"));
	homes.push(home);
	return home;
};
afterEach(async () => {
	for (const home of homes.splice(0)) {
		const descriptor = await readDescriptor(backendRunFile(home));
		if (descriptor && descriptor.pid !== process.pid && pidAlive(descriptor.pid)) {
			process.kill(descriptor.pid, "SIGTERM");
			for (let i = 0; i < 100 && pidAlive(descriptor.pid); i++) await Bun.sleep(20);
			if (pidAlive(descriptor.pid)) process.kill(descriptor.pid, "SIGKILL");
		}
		for (let attempt = 0; attempt < 8; attempt++) {
			try { rmSync(home, { recursive: true, force: true }); break; }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 7) throw error; await Bun.sleep(25); }
		}
	}
});

function contender(runFile: string) {
	const module = new URL("../src/service.ts", import.meta.url).href;
	return Bun.spawn([process.execPath, "-e", `
		import { claimBackend } from ${JSON.stringify(module)};
		const result = await claimBackend(${JSON.stringify(runFile)}, process.pid, 200);
		console.log(result.kind);
		if (result.kind === "claimed") await new Promise(() => setInterval(() => {}, 1000));
	`], { stdout: "pipe", stderr: "inherit" });
}
async function outcome(child: ReturnType<typeof contender>): Promise<string> {
	const reader = child.stdout.getReader();
	try { return new TextDecoder().decode((await reader.read()).value).trim(); }
	finally { reader.releaseLock(); }
}

function webDistWithIndex(home: string): string {
	const web = join(home, "web");
	mkdirSync(web, { recursive: true });
	writeFileSync(join(web, "index.html"), "<!doctype html><html><head></head><body><div id=root></div></body></html>");
	return web;
}

async function startService(home: string, role: BackendDescriptor["role"] = "dev") {
	const server = await startServer({
		port: 0,
		hostname: "127.0.0.1",
		cwd: home,
		webDist: webDistWithIndex(home),
		configPath: join(home, "config.json"),
		dataDir: join(home, "sessions"),
		service: { home, role, version: "9.9.9-test" },
	});
	return server;
}

function descriptorFixture(home: string, patch: Partial<BackendDescriptor>): BackendDescriptor {
	return {
		protocol: 2,
		version: "x",
		pid: process.pid,
		host: "127.0.0.1",
		port: 1,
		token: "ab".repeat(16),
		dataDir: join(home, "sessions"),
		configPath: join(home, "config.json"),
		machineId: "fixture",
		role: "dev",
		native: false,
		startedAt: 0,
		...patch,
	};
}

describe("machine backend ownership", () => {
	it("publishes a descriptor, refuses a second writer, and releases on close", async () => {
		const home = tmp();
		const server = await startService(home);
		const runFile = backendRunFile(home);
		const descriptor = (await readDescriptor(runFile))!;
		expect(descriptor.port).toBe(server.port);
		expect(descriptor.pid).toBe(process.pid);
		expect(descriptor.dataDir).toBe(join(home, "sessions"));
		expect(descriptor.role).toBe("dev");
		expect(descriptor.machineId).toMatch(/[0-9a-f-]{8,}/);
		expect((await probeBackend(descriptor)).ok).toBe(true);

		// A second starter over the same session space must not become a second writer:
		// the loser is told who owns it, with that owner's descriptor.
		let busy: BackendBusyError | undefined;
		try {
			await startService(home);
		} catch (error) {
			busy = error as BackendBusyError;
		}
		expect(busy).toBeInstanceOf(BackendBusyError);
		expect(busy?.descriptor?.pid).toBe(process.pid);
		expect(busy?.message).toContain("already running");

		await server.close();
		await Bun.sleep(50);
		expect(await readFile(runFile, "utf8").catch(() => undefined)).toBeUndefined();
	});

	it("replaces a run file whose process is gone and never steals from a live one", async () => {
		const home = tmp();
		mkdirSync(join(home, ".eta"), { recursive: true });
		const runFile = backendRunFile(home);
		writeFileSync(runFile, JSON.stringify(descriptorFixture(home, { pid: 999_999, machineId: "dead" })));
		expect(pidAlive(999_999)).toBe(false);
		const claimed = await claimBackend(runFile, process.pid, 100);
		expect(claimed.kind).toBe("claimed");
		if (claimed.kind === "claimed") await claimed.handle.release();

		// Alive but silent: somebody's process holds the session space, so it is
		// reported rather than taken over.
		writeFileSync(runFile, JSON.stringify(descriptorFixture(home, { port: 59_999, machineId: "live" })));
		const busy = await claimBackend(runFile, process.pid, 200);
		expect(busy.kind).toBe("busy");
		expect(await readDescriptor(runFile)).toBeDefined();
	});

	it("allows only one owner across concurrent processes", async () => {
		const runFile = backendRunFile(tmp());
		const children = Array.from({ length: 8 }, () => contender(runFile));
		try {
			const results = await Promise.all(children.map(outcome));
			expect(results.filter((result) => result === "claimed")).toHaveLength(1);
			expect(results.filter((result) => result === "busy")).toHaveLength(7);
			// Missing or partial ready information is not permission to steal the lock.
			writeFileSync(runFile, "");
			expect((await claimBackend(runFile, process.pid, 20)).kind).toBe("busy");
		} finally {
			for (const child of children) child.kill("SIGKILL");
			await Promise.all(children.map((child) => child.exited));
		}
	});

	it("keeps a live owner despite an expired heartbeat and recovers a crashed owner", async () => {
		const runFile = backendRunFile(tmp());
		const child = contender(runFile);
		try {
			expect(await outcome(child)).toBe("claimed");
			const old = new Date(Date.now() - 120_000);
			utimesSync(`${runFile}.lock`, old, old);
			expect((await claimBackend(runFile, process.pid, 20)).kind).toBe("busy");
			child.kill("SIGKILL");
			await child.exited;
			const next = await claimBackend(runFile, process.pid, 100);
			expect(next.kind).toBe("claimed");
			if (next.kind === "claimed") {
				await next.handle.release();
				const replacement = await claimBackend(runFile, process.pid, 100);
				expect(replacement.kind).toBe("claimed");
				await next.handle.release(); // Old cleanup must not release a later owner.
				expect(existsSync(`${runFile}.lock`)).toBe(true);
				if (replacement.kind === "claimed") await replacement.handle.release();
			}
		} finally { child.kill("SIGKILL"); await child.exited; }
	});

	it("releases ownership on startup failure and only after writers finish closing", async () => {
		const home = tmp();
		const runFile = backendRunFile(home);
		const occupied = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("busy") });
		try {
			await expect(startServer({ port: occupied.port, hostname: "127.0.0.1", dataDir: join(home, "sessions"), configPath: join(home, "config.json"), service: { home, role: "dev", version: "test" } })).rejects.toThrow();
			expect(existsSync(runFile)).toBe(false);
			expect(existsSync(`${runFile}.lock`)).toBe(false);
		} finally { occupied.stop(true); }
		const server = await startService(home);
		const closeHost = server.host.close.bind(server.host);
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => { finish = resolve; });
		server.host.close = async () => { await pending; await closeHost(); };
		const closing = server.close();
		try {
			expect((await claimBackend(runFile, process.pid, 20)).kind).toBe("busy");
			expect(existsSync(`${runFile}.lock`)).toBe(true);
		} finally { finish(); await closing; }
		expect(existsSync(runFile)).toBe(false);
		expect(existsSync(`${runFile}.lock`)).toBe(false);
	});

	it("requires its token on every api route and hands its own page the credential", async () => {
		const home = tmp();
		const server = await startService(home);
		const descriptor = (await readDescriptor(backendRunFile(home)))!;
		const base = `http://127.0.0.1:${String(server.port)}`;
		const auth = { authorization: `Bearer ${descriptor.token}` };

		expect((await fetch(`${base}/api/sessions`)).status).toBe(401);
		expect((await fetch(`${base}/api/sessions`, { headers: auth })).status).toBe(200);
		expect((await fetch(`${base}/api/health`)).status).toBe(401);
		expect(await (await fetch(`${base}/api/health`, { headers: auth })).json()).toMatchObject({
			protocol: 2,
			pid: process.pid,
			version: "9.9.9-test",
		});

		// The page this backend serves carries the credential, so the local UI does not
		// need a route left open to work.
		const page = await (await fetch(`${base}/`)).text();
		expect(page).toContain("window.__ETA_HOST__");
		expect(page).toContain(descriptor.token);
		await server.close();
	});

	it("accepts authenticated desktop clients without native handlers", async () => {
		const server = await startService(tmp(), "service");
		const base = `http://127.0.0.1:${server.port}`;
		try {
			for (const origin of ["null", "views://eta"]) {
				for (const path of ["/api/sessions", "/api/providers", "/api/providers/network"]) {
					const preflight = await fetch(`${base}${path}`, { method: "OPTIONS", headers: { origin, "access-control-request-headers": "authorization, content-type" } });
					expect(preflight.status).toBe(204);
					expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
					for (const token of [undefined, "wrong", server.token]) {
						const response = await fetch(`${base}${path}`, { headers: { origin, ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) } });
						expect(response.status).toBe(token === server.token ? 200 : 401);
					}
				}
				for (const token of ["wrong", server.token]) {
					const socket = new TestWebSocket(`${base.replace("http", "ws")}/ws?token=${token}`, { headers: { origin } });
					try {
						const accepted = await new Promise<boolean>((resolve) => {
							socket.addEventListener("open", () => resolve(true));
							socket.addEventListener("error", () => resolve(false));
						});
						expect(accepted).toBe(token === server.token);
					} finally { socket.close(); }
				}
			}
			for (const path of ["/api/sessions", "/api/providers", "/ws"]) {
				expect((await fetch(`${base}${path}`, { headers: { origin: "https://untrusted.example", authorization: `Bearer ${server.token}` } })).status).toBe(403);
			}
		} finally { await server.close(); }
	});

	it("stops itself only on request, and only with nothing running", async () => {
		const home = tmp();
		const server = await startService(home);
		const descriptor = (await readDescriptor(backendRunFile(home)))!;
		const base = `http://127.0.0.1:${String(server.port)}`;
		const kill = process.kill;
		const killed: number[] = [];
		process.kill = ((pid: number) => {
			killed.push(pid);
			return true;
		}) as typeof process.kill;
		try {
			const response = await fetch(`${base}/api/service/stop`, {
				method: "POST",
				headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
				body: "{}",
			});
			expect(response.status).toBe(200);
			await Bun.sleep(260);
			expect(killed).toEqual([process.pid]);
		} finally {
			process.kill = kill;
			await server.close();
		}
	});
});

function until(socket: WebSocket, match: (message: ServerMessage) => boolean): Promise<ServerMessage> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { socket.removeEventListener("message", onMessage); reject(new Error("Missing shared session update")); }, 3000);
		const onMessage = (event: MessageEvent) => {
			const message = JSON.parse(String(event.data)) as ServerMessage;
			if (!match(message)) return;
			clearTimeout(timer);
			socket.removeEventListener("message", onMessage);
			resolve(message);
		};
		socket.addEventListener("message", onMessage);
	});
}

function launcherOptions() {
	const home = tmp();
	const webDist = webDistWithIndex(home);
	return {
		home, webDist,
		command: process.env.ETA_TEST_SERVICE_BINARY
			? [process.env.ETA_TEST_SERVICE_BINARY, "serve"]
			: [process.execPath, fileURLToPath(new URL("../src/remote-main.ts", import.meta.url)), "serve"],
	};
}

async function desktopProcess(options: ReturnType<typeof launcherOptions>): Promise<BackendDescriptor> {
	const source = `import { ensureBackend } from ${JSON.stringify(new URL("../src/service-launcher.ts", import.meta.url).href)};
		console.log(JSON.stringify(await ensureBackend(${JSON.stringify(options)})));`;
	const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" });
	const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (code !== 0) throw new Error(error);
	return JSON.parse(out) as BackendDescriptor;
}

describe("desktop as a client of the independent service", () => {
	it("keeps the service alive after its desktop launcher exits and reuses it on reopen", async () => {
		const options = launcherOptions();
		const first = await desktopProcess(options);
		expect((await probeBackend(first)).ok).toBe(true);
		expect(first.role).toBe("service");
		expect(first.native).toBe(false);
		const page = await fetch(`http://127.0.0.1:${first.port}/`).then((response) => response.text());
		expect(page).toContain("id=root");
		const url = `ws://127.0.0.1:${first.port}/ws`;
		const remote = new TestWebSocket(url, { headers: { authorization: `Bearer ${first.token}` } });
		const desktop = new TestWebSocket(`${url}?token=${first.token}`, { headers: { origin: "views://eta" } });
		try {
			await Promise.all([remote, desktop].map((socket) => until(socket, (message) => "type" in message && message.type === "hello")));
			const visible = until(desktop, (message) => "type" in message && message.type === "sessions" && message.sessions.some((session) => session.name === "shared"));
			remote.send(JSON.stringify({ op: "session.create", name: "shared", personaId: "Thinker", cwd: options.home }));
			await visible;
		} finally { remote.close(); desktop.close(); }
		const reopened = await desktopProcess(options);
		expect(reopened.pid).toBe(first.pid);
		expect(reopened.token).toBe(first.token);
		const sessions = await fetch(`http://127.0.0.1:${reopened.port}/api/sessions`, { headers: { origin: "views://eta", authorization: `Bearer ${reopened.token}` } }).then((response) => response.json());
		expect(sessions).toEqual(expect.arrayContaining([expect.objectContaining({ name: "shared", cwd: options.home })]));
	}, 15_000);

	it("reuses a service started before desktop and converges concurrent launchers", async () => {
		const options = launcherOptions();
		const [a, b] = await Promise.all([desktopProcess(options), desktopProcess(options)]);
		expect(a.pid).toBe(b.pid);
		// An existing headless/SSH service needs no launchable local executable.
		const reused = await ensureBackend({ ...options, command: ["/nonexistent/eta-service"] });
		expect(reused.pid).toBe(a.pid);
		expect((await probeBackend(reused)).ok).toBe(true);
	}, 15_000);
});
