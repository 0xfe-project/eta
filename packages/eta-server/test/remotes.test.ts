import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backendRunFile, parseRemoteSession, remoteSessionName, type BackendDescriptor } from "@eta/core/remote";
import { startServer, type EtaServer } from "../src/server.ts";
import { discoverSshHosts, validHost } from "../src/remote-ssh.ts";
import { classifyRemoteError, mapRemoteFrame, validateConnection, type RemoteTransport } from "../src/remotes.ts";
import type { ServerMessage } from "../src/protocol.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "eta-remote-"));

async function plainServer(cwd: string, extra: Parameters<typeof startServer>[0] = {}): Promise<EtaServer> {
	return startServer({
		port: 0,
		hostname: "127.0.0.1",
		cwd,
		webDist: join(cwd, "no-dist"),
		configPath: join(cwd, "config.json"),
		dataDir: join(cwd, "sessions"),
		...extra,
	});
}

/** A machine that already runs its own eta, reachable over a fake SSH transport. */
async function machineWithBackend(configured = true): Promise<{ server: EtaServer; descriptor: BackendDescriptor; home: string }> {
	const home = tmp();
	if (configured) writeFileSync(join(home, "config.json"), JSON.stringify({ providers: [{ id: "remote", baseUrl: "http://127.0.0.1:1/v1", apiKey: "remote-test-only", models: [{ id: "one" }] }], defaultModel: "remote:one" }));
	const server = await startServer({
		port: 0,
		hostname: "127.0.0.1",
		cwd: home,
		webDist: join(home, "no-dist"),
		configPath: join(home, "config.json"),
		dataDir: join(home, "sessions"),
		service: { home, role: "service", version: "9.9.9-test" },
	});
	const descriptor = JSON.parse(await readFile(backendRunFile(home), "utf8")) as BackendDescriptor;
	return { server, descriptor, home };
}

class SocketReader {
	private readonly messages: ServerMessage[] = [];
	private readonly waiters: { resolve(m: ServerMessage): void; timer: ReturnType<typeof setTimeout> }[] = [];

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
			this.waiters.push({ resolve, timer });
		});
	}
}

async function connect(server: EtaServer): Promise<WebSocket> {
	const socket = new WebSocket(`ws://127.0.0.1:${String(server.port)}/ws`);
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("ws error")), { once: true });
	});
	new SocketReader(socket);
	return socket;
}

describe("remote identity", () => {
	it("round-trips a session name and rejects command-like hosts", () => {
		const name = remoteSessionName("dev-1", "eta-abc");
		expect(parseRemoteSession(name)).toEqual({ connectionId: "dev-1", session: "eta-abc" });
		expect(parseRemoteSession("eta-abc")).toBeUndefined();
		expect(validHost("devbox")).toBe(true);
		expect(validHost("foo;rm")).toBe(false);
		expect(() => validateConnection({ name: "x", host: "devbox;id" })).toThrow();
		expect(validateConnection({ name: "Dev", host: "devbox", identityFile: "~/.ssh/id_ed25519" }).identityFile).toBe(
			"~/.ssh/id_ed25519",
		);
	});

	it("maps remote frames onto prefixed session ids", () => {
		expect(
			mapRemoteFrame("abc", { channel: "dev", frame: { ts: 1, session: "s1", category: "x", action: "y", data: {} } }),
		).toMatchObject({ frame: { session: "remote:abc:s1" } });
		expect(mapRemoteFrame("abc", { type: "created", name: "s1" })).toEqual({ type: "created", name: "remote:abc:s1" });
	});

	it("classifies failures into something a person can act on", () => {
		expect(classifyRemoteError(new Error("avaca@192.168.198.85: Permission denied (publickey).")).kind).toBe("auth");
		expect(classifyRemoteError(new Error("ssh: connect to host mac-mini port 22: Connection refused")).kind).toBe("unreachable");
		expect(classifyRemoteError(new Error("just odd")).kind).toBe("other");
	});
});

describe("ssh config discovery", () => {
	it("reads concrete aliases, skips patterns, and follows include", async () => {
		const dir = tmp();
		const extra = join(dir, "extra");
		writeFileSync(extra, "Host included\n  HostName 10.0.0.2\n");
		writeFileSync(join(dir, "config"), `Host *\n  ForwardAgent yes\nHost devbox\n  HostName 10.0.0.1\nInclude ${extra}\n`);
		expect(await discoverSshHosts(join(dir, "config"))).toEqual(["devbox", "included"]);
	});
});

describe("adopting the machine's backend", () => {
	/** Every script the manager sent, so a test can prove what it did *not* run. */
	async function harness(options: {
		/** What is in ~/.eta/run.json on the machine: a live backend, or nothing. */
		descriptor?: BackendDescriptor | undefined;
		/** What the launch script finds after starting the installed build. */
		launchDescriptor?: BackendDescriptor;
		installed?: string;
		execOverride?: (script: string) => string | undefined;
	}) {
		const localDir = tmp();
		writeFileSync(join(localDir, "config.json"), JSON.stringify({ providers: [{ id: "local", baseUrl: "http://127.0.0.1:1/v1", apiKey: "local-test-only", models: [{ id: "one" }] }], defaultModel: "local:one" }));
		const scripts: string[] = [];
		const hanging: ReturnType<typeof Bun.spawn>[] = [];
		const transport: RemoteTransport = {
			exec: async (_connection, script) => {
				scripts.push(script);
				const override = options.execOverride?.(script);
				if (override !== undefined) return override;
				if (script.includes("uname -s")) {
					const installed = options.installed ?? "aa".repeat(10);
					return `Darwin\narm64\n{"platform":"Darwin","arch":"arm64","installed":"${installed}"}`;
				}
				if (script.includes('cat "$HOME/.eta/run.json"')) return options.descriptor === undefined ? "" : JSON.stringify(options.descriptor, null, 2);
				if (script.includes("nohup")) return options.launchDescriptor === undefined ? "" : JSON.stringify(options.launchDescriptor, null, 2);
				throw new Error(`unexpected script: ${script.slice(0, 60)}`);
			},
			inspect: async () => ({ hostname: "mac-mini", user: "avaca" }),
			openTunnel: async (_connection, remotePort) => {
				const process = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
				hanging.push(process);
				return { localPort: remotePort, process };
			},
			artifact: async () => {
				throw new Error("artifact should not be built when nothing needs deploying");
			},
		};
		const local = await plainServer(localDir, { remoteTransport: transport });
		const created = await fetch(`http://127.0.0.1:${String(local.port)}/api/remotes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "mac-mini", host: "mac-mini" }),
		});
		const id = ((await created.json()) as { id: string }[])[0]!.id;
		const post = (path: string, body: unknown = {}) =>
			fetch(`http://127.0.0.1:${String(local.port)}/api/remotes/${id}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		const view = async () =>
			((await (await fetch(`http://127.0.0.1:${String(local.port)}/api/remotes`)).json()) as {
				status: string;
				error?: string;
				logs: string[];
				backend?: { reused: boolean; version: string; pid: number };
			}[])[0]!;
		return {
			local,
			id,
			scripts,
			post,
			view,
			close: () => {
				local.close();
				for (const process of hanging) process.kill();
			},
		};
	}

	it("adopts the backend already running there instead of starting another", async () => {
		const machine = await machineWithBackend();
		const test = await harness({ descriptor: machine.descriptor });
		try {
			expect((await test.post("/connect")).status).toBe(200);
			const view = await test.view();
			expect(view.status).toBe("connected");
			expect(view.backend).toMatchObject({ reused: true, version: "9.9.9-test", pid: process.pid });
			expect(view.logs.join("\n")).toContain("Reusing the eta already running");
			// Nothing was launched and nothing was uploaded: this was somebody's backend.
			expect(test.scripts.some((script) => script.includes("nohup"))).toBe(false);
			expect(test.scripts.some((script) => script.includes("eta.upload"))).toBe(false);

			// ...and it is the machine's own sessions that come through the tunnel.
			const socket = await connect(test.local);
			socket.send(JSON.stringify({ op: "session.create", remoteId: test.id, name: "eta-1", personaId: "Thinker", cwd: machine.home }));
			let listed: { name: string; remote?: { connectionId: string } }[] = [];
			const deadline = Date.now() + 8000;
			while (Date.now() < deadline) {
				listed = (await (await fetch(`http://127.0.0.1:${String(test.local.port)}/api/sessions`)).json()) as typeof listed;
				if (listed.some((session) => session.remote?.connectionId === test.id)) break;
				await Bun.sleep(50);
			}
			expect(listed.some((session) => session.remote?.connectionId === test.id)).toBe(true);
			socket.close();
		} finally {
			test.close();
			machine.server.close();
		}
	}, 20_000);

	it("uses only the target catalog and rejects local-only model ids", async () => {
		const machine = await machineWithBackend();
		const test = await harness({ descriptor: machine.descriptor });
		let socket: WebSocket | undefined;
		try {
			expect((await test.post("/connect")).status).toBe(200);
			const catalog = await fetch(`http://127.0.0.1:${test.local.port}/api/remote/${test.id}/api/models`).then((response) => response.json());
			expect(catalog.models.map((model: { id: string }) => model.id)).toEqual(["remote:one"]);
			socket = await connect(test.local);
			const reader = new SocketReader(socket);
			socket.send(JSON.stringify({ op: "session.create", remoteId: test.id, name: "invalid", personaId: "Thinker", cwd: machine.home, modelId: "local:one" }));
			let frame = await reader.next();
			while (!("type" in frame && frame.type === "error")) frame = await reader.next();
			expect(frame).toMatchObject({ message: expect.stringContaining("not configured on mac-mini") });
			expect([...machine.server.host.names()]).not.toContain("invalid");
			socket.send(JSON.stringify({ op: "session.create", remoteId: test.id, name: "valid", personaId: "Thinker", cwd: machine.home }));
			frame = await reader.next();
			while (!("type" in frame && frame.type === "created")) frame = await reader.next();
			expect(machine.server.host.modelInfo("valid").current).toBe("remote:one");
			socket.send(JSON.stringify({ op: "modelSet", session: remoteSessionName(test.id, "valid"), modelId: "local:one" }));
			frame = await reader.next();
			while (!("type" in frame && frame.type === "error")) frame = await reader.next();
			expect(machine.server.host.modelInfo("valid").current).toBe("remote:one");
		} finally { socket?.close(); test.close(); await machine.server.close(); }
	});

	it("does not fall back to local models when the target has none", async () => {
		const machine = await machineWithBackend(false);
		const test = await harness({ descriptor: machine.descriptor });
		let socket: WebSocket | undefined;
		try {
			expect((await test.post("/connect")).status).toBe(200);
			socket = await connect(test.local);
			const reader = new SocketReader(socket);
			socket.send(JSON.stringify({ op: "session.create", remoteId: test.id, name: "no-model", personaId: "Thinker", cwd: machine.home }));
			let frame = await reader.next();
			while (!("type" in frame && frame.type === "error")) frame = await reader.next();
			expect(frame).toMatchObject({ message: expect.stringContaining("Configure models on mac-mini") });
			expect([...machine.server.host.names()]).toEqual([]);
		} finally { socket?.close(); test.close(); await machine.server.close(); }
	});

	it("launches the installed build only when nothing owns the machine", async () => {
		const machine = await machineWithBackend();
		// Nothing in ~/.eta/run.json, but the launch script starts a build that then
		// publishes exactly the descriptor the stand-in backend is serving.
		const test = await harness({ descriptor: undefined, launchDescriptor: machine.descriptor });
		try {
			expect((await test.post("/connect")).status).toBe(200);
			const view = await test.view();
			expect(view.status).toBe("connected");
			expect(view.backend).toMatchObject({ version: "9.9.9-test" });
			expect(view.logs.join("\n")).toContain("Starting eta on the machine");
			expect(test.scripts.some((script) => script.includes("nohup"))).toBe(true);
		} finally {
			test.close();
			machine.server.close();
		}
	}, 20_000);

	it("reports a protocol it cannot speak instead of killing that service", async () => {
		const machine = await machineWithBackend();
		const stale: BackendDescriptor = { ...machine.descriptor, protocol: 1 };
		const test = await harness({ descriptor: stale });
		try {
			const response = await test.post("/connect");
			expect(response.status).toBe(400);
			expect(await response.text()).toContain("protocol 1");
			expect(test.scripts.some((script) => script.includes("nohup"))).toBe(false);
			expect(test.scripts.some((script) => script.includes("kill"))).toBe(false);
		} finally {
			test.close();
			machine.server.close();
		}
	}, 20_000);

	it("keeps retrying an unreachable machine, and a manual disconnect stops it", async () => {
		let calls = 0;
		const test = await harness({
			execOverride: (script) => {
				if (script.includes("uname -s")) {
					calls += 1;
					throw new Error("ssh: connect to host mac-mini port 22: Connection refused");
				}
				return undefined;
			},
		});
		try {
			const response = await test.post("/connect");
			expect(response.status).toBe(400);
			expect(await response.text()).toContain("Connection refused");
			const view = await test.view();
			expect(view.status).toBe("reconnecting");
			const before = calls;
			await Bun.sleep(1600);
			expect(calls).toBeGreaterThan(before);
			await test.post("/disconnect");
			const settled = calls;
			await Bun.sleep(1600);
			expect(calls).toBe(settled);
		} finally {
			test.close();
		}
	}, 20_000);
});
