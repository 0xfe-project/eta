/**
 * SSH connections to another machine's eta.
 *
 * The unit this manages is not "a remote service we deployed" but "the backend that
 * owns that machine's sessions". If one is already running — started at login, by the
 * desktop app, by `bun run dev` — this adopts it: the tunnel points at its loopback
 * port and the token comes from the run file it published, so the sessions and model
 * providers are the ones that machine already has. Only when nothing is running does
 * an installed build get launched, and that build claims the same session space
 * instead of opening a second one.
 *
 * Nothing here ever signals a process it did not start: an older backend that owns the
 * machine is reported, not killed.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
	BACKEND_PROTOCOL,
	isClaim,
	isDescriptor,
	parseRemoteSession,
	remoteSessionName,
	type BackendDescriptor,
	type RemoteBackend,
	type RemoteHostKey,
	type RemoteConnection,
	type RemoteStatus,
	type RemoteView,
} from "@eta/core/remote";
import type { ClientMessage, ServerMessage, SidebarSession } from "./protocol.ts";
import { confirmSshHost, hostKeyFingerprint } from "./remote-host-key.ts";
import { command, discoverSshHosts, freePort, remoteArtifact, ssh, sshArgs, validHost } from "./remote-ssh.ts";

const RemoteWebSocket = WebSocket as unknown as {
	new (url: string, options: { headers: Record<string, string> }): WebSocket;
};

type Process = ReturnType<typeof Bun.spawn>;

/** What went wrong, in terms a person can act on. */
export type RemoteFailureKind = "unreachable" | "auth" | "not-installed" | "protocol" | "busy" | "no-service" | "host-key" | "host-key-changed" | "other";

export class RemoteError extends Error {
	readonly kind: RemoteFailureKind;
	constructor(kind: RemoteFailureKind, message: string) {
		super(message);
		this.kind = kind;
	}
}

export function classifyRemoteError(error: unknown): { kind: RemoteFailureKind; message: string } {
	if (error instanceof RemoteError) return { kind: error.kind, message: error.message };
	const message = error instanceof Error ? error.message : String(error);
	if (/REMOTE HOST IDENTIFICATION HAS CHANGED|REVOKED HOST KEY/i.test(message)) return { kind: "host-key-changed", message };
	if (/host key verification failed|no .*host key is known/i.test(message)) return { kind: "host-key", message };
	if (/permission denied|publickey|authentication failed|too many authentication failures/i.test(message))
		return { kind: "auth", message };
	if (/could not resolve hostname|no route to host|connection refused|connection timed out|operation timed out|network is unreachable|nodename nor servname/i.test(message))
		return { kind: "unreachable", message };
	return { kind: "other", message };
}

/** Errors that need user intervention rather than automatic retries. */
const FATAL_KINDS: readonly RemoteFailureKind[] = ["auth", "not-installed", "protocol", "busy", "host-key", "host-key-changed"];
const MAX_RETRIES = 3;

export interface RemoteTransport {
	confirmHost?(connection: RemoteConnection, expected?: string): Promise<string>;
	exec(connection: RemoteConnection, script: string, input?: Uint8Array, timeoutMs?: number): Promise<string>;
	inspect(connection: RemoteConnection): Promise<{ hostname: string; user: string }>;
	openTunnel(connection: RemoteConnection, remotePort: number, localPort?: number): Promise<{ localPort: number; process: Process }>;
	artifact(platform: string, arch: string): Promise<{ path: string; version: string }>;
}

export const defaultRemoteTransport: RemoteTransport = {
	confirmHost: confirmSshHost,
	exec: ssh,
	async inspect(connection) {
		const resolved = await command(["ssh", ...sshArgs(connection), "-G", "--", connection.host]);
		if (resolved.code) throw new Error(resolved.stderr.trim() || `ssh -G exited ${resolved.code}`);
		const fields = Object.fromEntries(
			resolved.stdout.split("\n").map((line) => {
				const at = line.indexOf(" ");
				return [line.slice(0, at), line.slice(at + 1)];
			}),
		);
		return { hostname: fields.hostname ?? connection.host, user: fields.user ?? "" };
	},
	async openTunnel(connection, remotePort, localPort) {
		const port = localPort || (await freePort());
		const process = Bun.spawn(
			[
				"ssh",
				...sshArgs(connection),
				"-N",
				"-o",
				"ExitOnForwardFailure=yes",
				"-L",
				`127.0.0.1:${port}:127.0.0.1:${remotePort}`,
				"--",
				connection.host,
			],
			{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
		);
		return { localPort: port, process };
	},
	artifact: remoteArtifact,
};

interface Live {
	status: RemoteStatus;
	error?: string;
	errorKind?: RemoteFailureKind;
	logs: string[];
	generation: number;
	wanted: boolean;
	attempt: number;
	retry?: ReturnType<typeof setTimeout>;
	process?: Process;
	base?: string;
	token?: string;
	socket?: WebSocket;
	descriptor?: BackendDescriptor;
	backend?: RemoteBackend;
	sessions: SidebarSession[];
	views: Map<string, ServerMessage>;
	ports: Map<string, { proc: Process; port: number }>;
}

/** One SSH round trip that answers everything the connect step needs to know. */
const INSPECT_SCRIPT = `set -u
uname -s; uname -m
installed=""
if [ -f "$HOME/.eta/remote/installed" ]; then installed=$(cat "$HOME/.eta/remote/installed" 2>/dev/null | tr -d '\\r\\n'); fi
printf '{"platform":"%s","arch":"%s","installed":"%s"}\\n' "$(uname -s)" "$(uname -m)" "$installed"`;

interface Inspect {
	platform: string;
	arch: string;
	installed: string;
}

/**
 * Start through the same ownership lock as desktop. Wait for a ready descriptor;
 * the starting claim is not a usable service and must never be deleted here.
 */
const LAUNCH_SCRIPT = `set -eu
umask 077
root="$HOME/.eta/remote"
version=$(cat "$root/installed" 2>/dev/null | tr -d '\\r\\n' || true)
[ -n "$version" ] || { echo 'Eta is not installed on this machine. Choose Install / Update first.' >&2; exit 1; }
bin="$root/versions/$version/eta"
[ -x "$bin" ] || { echo "The installed eta binary is missing: $bin. Choose Install / Update." >&2; exit 1; }
mkdir -p "$root"
run="$HOME/.eta/run.json"
nohup "$bin" serve </dev/null >>"$root/server.log" 2>&1 &
for i in $(seq 1 300); do
  if [ -f "$run" ]; then
    pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$run" | head -1)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && grep -q '"port"' "$run"; then cat "$run"; exit 0; fi
  fi
  sleep 0.2
done
echo 'Remote eta did not publish ~/.eta/run.json. Inspect ~/.eta/remote/server.log on the host.' >&2
exit 1`;

export class RemoteManager {
	private connections: RemoteConnection[] = [];
	private hostKeys = new Map<string, { view: RemoteHostKey; config: string; expires: number }>();
	private live = new Map<string, Live>();
	private saveTail = Promise.resolve();
	private closed = false;
	private path: string;
	private emit: (message: ServerMessage) => void;
	private changed: () => void;
	private transport: RemoteTransport;

	constructor(
		path: string,
		emit: (message: ServerMessage) => void,
		changed: () => void,
		transport: RemoteTransport = defaultRemoteTransport,
	) {
		this.path = path;
		this.emit = emit;
		this.changed = changed;
		this.transport = transport;
	}

	async load(): Promise<void> {
		try {
			const saved = JSON.parse(await readFile(this.path, "utf8"));
			if (!Array.isArray(saved.connections)) throw new Error("Invalid remote configuration");
			for (const row of saved.connections) {
				const connection = validateConnection(row);
				this.connections.push(connection);
				const live = this.runtime(connection.id);
				live.sessions = Array.isArray(saved.sessions?.[connection.id]) ? saved.sessions[connection.id] : [];
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	start(): void {
		for (const connection of this.connections) if (connection.autoConnect) void this.connect(connection.id).catch(() => {});
	}

	private runtime(id: string): Live {
		let live = this.live.get(id);
		if (!live) {
			live = {
				status: "disconnected",
				logs: [],
				generation: 0,
				wanted: false,
				attempt: 0,
				sessions: [],
				views: new Map(),
				ports: new Map(),
			};
			this.live.set(id, live);
		}
		return live;
	}

	private config(id: string): RemoteConnection {
		const connection = this.connections.find((row) => row.id === id);
		if (!connection) throw new Error("Unknown SSH connection");
		return connection;
	}

	private notify(id: string, status: RemoteStatus, text?: string): void {
		const live = this.runtime(id);
		live.status = status;
		if (text) live.logs = [...live.logs, `${new Date().toISOString()} ${text}`].slice(-60);
		this.changed();
	}

	list(): RemoteView[] {
		return this.connections.map((connection) => {
			const live = this.runtime(connection.id);
			return {
				...connection,
				status: live.status,
				error: live.error,
				version: live.backend?.version,
				logs: live.logs,
				...(live.backend === undefined ? {} : { backend: live.backend }),
				ports: connection.forwards.map((port) => ({
					...port,
					localPort: live.ports.get(port.id)?.port ?? port.localPort,
					active: live.ports.has(port.id),
				})),
			};
		});
	}

	sidebar(): SidebarSession[] {
		return this.connections.flatMap((connection) => {
			const live = this.runtime(connection.id);
			return live.sessions.map((session) => ({
				...session,
				name: remoteSessionName(connection.id, session.name),
				remote: {
					connectionId: connection.id,
					host: connection.host,
					label: connection.name,
					status: live.status,
				},
				// The machine prefix is the workspace identity; the row itself wears no
				// badge for it (the group header does), and "running" only holds while we
				// can actually see the run.
				badges: session.badges.filter((badge) => live.status === "connected" || badge !== "running"),
			}));
		});
	}

	private save(): Promise<void> {
		const text = JSON.stringify(
			{
				connections: this.connections,
				sessions: Object.fromEntries(this.connections.map((row) => [row.id, this.runtime(row.id).sessions])),
			},
			null,
			2,
		);
		this.saveTail = this.saveTail.catch(() => {}).then(async () => {
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			await writeFile(`${this.path}.tmp`, text, { mode: 0o600 });
			await rename(`${this.path}.tmp`, this.path);
		});
		return this.saveTail;
	}

	async upsert(input: unknown): Promise<RemoteView[]> {
		const connection = validateConnection(input);
		const old = this.connections.find((row) => row.id === connection.id);
		if (old && !["disconnected", "error", "awaiting-trust"].includes(this.runtime(old.id).status))
			throw new Error("Disconnect before editing the SSH connection");
		if (old) {
			connection.projects = old.projects;
			connection.forwards = old.forwards;
			Object.assign(old, connection);
		} else this.connections.push(connection);
		await this.save();
		this.changed();
		return this.list();
	}

	async remove(id: string): Promise<void> {
		this.config(id);
		this.disconnect(id);
		this.connections = this.connections.filter((row) => row.id !== id);
		this.live.delete(id);
		await this.save();
		this.changed();
	}

	async discover(): Promise<string[]> {
		return discoverSshHosts();
	}

	/** First contact is a pending decision, not a failed connection. */
	private awaitHostTrust(id: string): void {
		const live = this.runtime(id);
		live.wanted = false;
		live.generation++;
		this.cleanup(live);
		live.error = undefined;
		live.errorKind = undefined;
		this.notify(id, "awaiting-trust", "Waiting for host fingerprint confirmation. Choose Test or Connect to review it.");
	}

	async hostKey(id: string): Promise<RemoteHostKey> {
		const connection = this.config(id);
		const config = JSON.stringify(connection);
		if (!this.transport.confirmHost) throw new Error("Host key confirmation unavailable");
		const prompt = await this.transport.confirmHost(connection);
		const fingerprint = hostKeyFingerprint(prompt);
		if (!fingerprint) throw new Error("Could not read the SSH host fingerprint");
		if (config !== JSON.stringify(this.config(id))) throw new Error("Connection settings changed; try again");
		const host = /^The authenticity of host '([^']+)'/.exec(prompt)?.[1] ?? connection.host;
		const view = { challengeId: crypto.randomUUID(), host, prompt, ...fingerprint };
		this.hostKeys.set(id, { view, config, expires: Date.now() + 5 * 60_000 });
		this.awaitHostTrust(id);
		return view;
	}

	async trustHost(id: string, challengeId: unknown): Promise<void> {
		const pending = this.hostKeys.get(id);
		if (!pending || pending.view.challengeId !== challengeId || pending.expires < Date.now()
			|| pending.config !== JSON.stringify(this.config(id))) throw new Error("Host key confirmation expired; test the connection again");
		this.hostKeys.delete(id);
		if (!this.transport.confirmHost) throw new Error("Host key confirmation unavailable");
		await this.transport.confirmHost(this.config(id), pending.view.prompt);
		this.notify(id, "disconnected", "Host fingerprint trusted. Ready to connect.");
	}

	async test(id: string): Promise<{ hostname: string; user: string; platform: string; backend?: RemoteBackend }> {
		try {
			const connection = this.config(id);
			const resolved = await this.transport.inspect(connection);
			const inspect = await this.inspectRemote(connection);
			const descriptor = await this.readDescriptor(connection);
			return {
				...resolved,
				platform: `${inspect.platform} ${inspect.arch}`,
				...(descriptor === undefined
					? {}
					: { backend: { version: descriptor.version, protocol: descriptor.protocol, pid: descriptor.pid, machineId: descriptor.machineId, reused: false, ...(inspect.installed === "" ? {} : { installed: inspect.installed }) } }),
			};
		} catch (error) {
			if (classifyRemoteError(error).kind === "host-key") this.awaitHostTrust(id);
			throw error;
		}
	}

	private async inspectRemote(connection: RemoteConnection): Promise<Inspect> {
		const raw = await this.transport.exec(connection, INSPECT_SCRIPT);
		const line = raw.split("\n").find((row) => row.trim().startsWith("{")) ?? "";
		try {
			const parsed = JSON.parse(line) as Inspect;
			return {
				platform: parsed.platform,
				arch: parsed.arch,
				installed: typeof parsed.installed === "string" ? parsed.installed : "",
			};
		} catch {
			throw new RemoteError("other", "Could not read the remote eta layout over SSH");
		}
	}

	/** The machine's descriptor, when a backend owns it right now. */
	private async readDescriptor(connection: RemoteConnection): Promise<BackendDescriptor | undefined> {
		const raw = await this.transport.exec(connection, `cat "$HOME/.eta/run.json" 2>/dev/null || true`);
		const text = raw.trim();
		if (text.length === 0) return undefined;
		try {
			const value = JSON.parse(text);
			if (isDescriptor(value)) return value;
			if (isClaim(value)) return undefined;
			return undefined;
		} catch {
			return undefined;
		}
	}

	private cleanup(live: Live): void {
		clearTimeout(live.retry);
		live.retry = undefined;
		live.socket?.close();
		live.socket = undefined;
		live.process?.kill();
		live.process = undefined;
		for (const port of live.ports.values()) port.proc.kill();
		live.ports.clear();
		live.base = undefined;
		live.token = undefined;
	}

	disconnect(id: string): void {
		const live = this.runtime(id);
		live.wanted = false;
		live.generation++;
		this.cleanup(live);
		// Sessions stay in the sidebar: they still exist on that machine, and the group
		// header says the host is not connected.
		this.notify(id, "disconnected", "Disconnected. The service on the machine keeps running.");
	}

	private retryDelay(attempt: number): number {
		return Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)) + Math.floor(Math.random() * 400);
	}

	/** A lost transport, or a connect that failed: same schedule, same ceiling. */
	private scheduleRetry(id: string, live: Live, reason: RemoteFailureKind): void {
		if (this.closed || !live.wanted) return;
		if (FATAL_KINDS.includes(reason) || live.attempt >= MAX_RETRIES) {
			live.wanted = false;
			this.notify(id, "error", `Giving up after ${String(live.attempt)} retries: ${live.error ?? reason}. Reconnect when the problem is fixed.`);
			return;
		}
		this.notify(id, "reconnecting", `Retrying in ${String(Math.round(this.retryDelay(live.attempt) / 1000))}s (attempt ${String(live.attempt + 1)}, ${reason}).`);
		live.retry = setTimeout(() => void this.connectAttempt(id, false).catch(() => {}), this.retryDelay(live.attempt));
		live.attempt += 1;
	}

	private lost(id: string, generation: number): void {
		const live = this.runtime(id);
		if (this.closed || live.generation !== generation || !live.wanted) return;
		live.generation++;
		this.cleanup(live);
		// Views cached from a connection that died are not resynced state: whoever comes
		// back asks the machine again instead of being served the last thing we saw.
		live.views.clear();
		this.notify(id, "reconnecting", "Transport lost. Reconnecting; the machine keeps its sessions and runs.");
		this.scheduleRetry(id, live, "unreachable");
	}

	async connect(id: string, install = false): Promise<void> {
		return this.connectAttempt(id, install, true);
	}

	private async connectAttempt(id: string, install: boolean, manual = false): Promise<void> {
		const connection = this.config(id);
		const live = this.runtime(id);
		if (["checking", "installing", "connecting"].includes(live.status)) throw new Error("Connection is busy");
		if (live.status === "connected" && !install) return;
		if (manual) live.attempt = 0;
		live.wanted = true;
		live.generation++;
		const generation = live.generation;
		this.cleanup(live);
		live.error = undefined;
		live.errorKind = undefined;
		const current = (): void => {
			if (live.generation !== generation || this.closed) throw new Error("Connection cancelled");
		};
		try {
			this.notify(id, "checking", "Checking SSH host and the eta backend it owns.");
			const inspect = await this.inspectRemote(connection);
			current();
			if (install) {
				this.notify(id, "installing", `Uploading a versioned eta build for ${inspect.platform} ${inspect.arch}. Local credentials are not copied.`);
				const artifact = await this.transport.artifact(inspect.platform, inspect.arch);
				current();
				const bytes = new Uint8Array(await Bun.file(artifact.path).arrayBuffer());
				await this.transport.exec(
					connection,
					`set -eu; umask 077; d="$HOME/.eta/remote/versions/${artifact.version}"; mkdir -p "$d"; cat > "$d/eta.upload"; chmod 700 "$d/eta.upload"; mv "$d/eta.upload" "$d/eta"; printf '%s' '${artifact.version}' > "$HOME/.eta/remote/installed"`,
					bytes,
					240_000,
				);
				current();
				live.logs = [...live.logs, `${new Date().toISOString()} Installed build ${artifact.version}; a running backend keeps serving until it is stopped and started again.`].slice(-60);
			}
			let descriptor = await this.readDescriptor(connection);
			current();
			if (descriptor !== undefined && descriptor.protocol !== BACKEND_PROTOCOL) {
				throw new RemoteError(
					"protocol",
					`The eta backend on ${connection.host} speaks protocol ${String(descriptor.protocol)}, this client speaks ${String(BACKEND_PROTOCOL)}. Stop that service (设置 → 停止机器上的服务) or update it, then connect again.`,
				);
			}
			let reused = descriptor !== undefined && (await this.attach(id, connection, descriptor, generation));
			if (!reused) {
				const installed = (await this.inspectRemote(connection)).installed;
				current();
				if (installed === "")
					throw new RemoteError("not-installed", `Eta is not installed on ${connection.host}. Choose Install / Update to place a build under ~/.eta/remote.`);
				if (descriptor !== undefined) this.notify(id, "connecting", "Nothing answered on this machine's run file; starting its eta.");
				else this.notify(id, "connecting", "Starting eta on the machine, using its own sessions and providers.");
				const launched = (await this.launchRemote(connection)) ?? (await this.readDescriptor(connection));
				current();
				if (launched === undefined) throw new RemoteError("other", `Remote eta did not publish ~/.eta/run.json. Inspect ~/.eta/remote/server.log on ${connection.host}.`);
				if (launched.protocol !== BACKEND_PROTOCOL)
					throw new RemoteError("protocol", `The backend that started on ${connection.host} speaks protocol ${String(launched.protocol)}; install an updated build.`);
				descriptor = launched;
				reused = await this.attach(id, connection, launched, generation);
				if (!reused) throw new RemoteError("other", `Could not reach the eta backend that just started on ${connection.host}.`);
			}
			current();
			if (descriptor === undefined) throw new RemoteError("other", `No eta backend is running on ${connection.host}.`);
			const backend = descriptor;
			live.attempt = 0;
			this.notify(
				id,
				"connected",
				reused
					? `Reusing the eta already running on ${connection.host} (pid ${String(backend.pid)}): its sessions and providers are the ones you see.`
					: `Connected to the eta running on ${connection.host} (pid ${String(backend.pid)}).`,
			);
			this.warnDuplicateMachine(id, backend.machineId);
			for (const forward of connection.forwards)
				await this.startForward(id, forward.id).catch((error) =>
					this.notify(id, "connected", `Port forward failed: ${String(error)}`),
				);
		} catch (error) {
			if (live.generation !== generation) return;
			this.cleanup(live);
			const failure = classifyRemoteError(error);
			if (failure.kind === "host-key") {
				this.awaitHostTrust(id);
				throw error;
			}
			live.error = failure.message;
			live.errorKind = failure.kind;
			this.notify(id, "error", failure.message);
			if (live.wanted) this.scheduleRetry(id, live, failure.kind);
			throw error;
		}
	}

	/** Two entries pointing at one machine would show the same sessions twice. */
	private warnDuplicateMachine(id: string, machineId: string): void {
		for (const [other, live] of this.live) {
			if (other === id || live.status !== "connected" || live.descriptor?.machineId !== machineId) continue;
			const row = this.connections.find((connection) => connection.id === other);
			this.notify(id, "connected", `Heads up: ${row?.name ?? other} points at the same machine (machine id ${machineId.slice(0, 8)}); both entries show the same sessions.`);
			return;
		}
	}

	/** Tunnel to a published backend and subscribe to it. False when it does not answer. */
	private async attach(id: string, connection: RemoteConnection, descriptor: BackendDescriptor, generation: number): Promise<boolean> {
		const live = this.runtime(id);
		live.descriptor = descriptor;
		live.token = descriptor.token;
		try {
			const tunnel = await this.transport.openTunnel(connection, descriptor.port);
			if (live.generation !== generation) {
				tunnel.process.kill();
				return false;
			}
			live.process = tunnel.process;
			live.base = `http://127.0.0.1:${String(tunnel.localPort)}`;
			void tunnel.process.exited.then(() => this.lost(id, generation));
			let health: { protocol?: number; version?: string } | undefined;
			for (let attempt = 0; attempt < 20; attempt++) {
				if (live.generation !== generation) return false;
				if (tunnel.process.exitCode !== null) return false;
				try {
					const response = await this.fetch(id, "/api/health", { signal: AbortSignal.timeout(1000) }, true);
					if (response.ok) {
						health = (await response.json()) as { protocol?: number; version?: string };
						break;
					}
				} catch {
					/* tunnel warming up */
				}
				await Bun.sleep(150);
			}
			if (health?.protocol !== BACKEND_PROTOCOL) return false;
			live.backend = {
				version: health.version ?? descriptor.version,
				protocol: descriptor.protocol,
				pid: descriptor.pid,
				machineId: descriptor.machineId,
				reused: true,
			};
			await this.openSocket(id, generation);
			return true;
		} catch {
			if (live.process !== undefined && live.generation === generation) {
				live.process.kill();
				live.process = undefined;
			}
			return false;
		}
	}

	private async launchRemote(connection: RemoteConnection): Promise<BackendDescriptor | undefined> {
		const raw = await this.transport.exec(connection, LAUNCH_SCRIPT, undefined, 120_000);

		try {
			const value = JSON.parse(raw);
			return isDescriptor(value) ? value : undefined;
		} catch {
			return undefined;
		}
	}

	private async openSocket(id: string, generation: number): Promise<void> {
		const live = this.runtime(id);
		await new Promise<void>((resolve, reject) => {
			const socket = new RemoteWebSocket(`${live.base!.replace("http:", "ws:")}/ws`, {
				headers: { authorization: `Bearer ${live.token}` },
			});
			live.socket = socket;
			let settled = false;
			const finish = (error?: Error): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (error) reject(error);
				else resolve();
			};
			const timer = setTimeout(() => {
				finish(new Error("Remote session handshake timed out"));
				socket.close();
			}, 15_000);
			socket.addEventListener("message", (event) => {
				if (live.generation !== generation) return;
				try {
					const message = JSON.parse(String(event.data)) as ServerMessage;
					if ("type" in message && (message.type === "hello" || message.type === "sessions")) {
						live.sessions = message.sessions;
						for (const name of live.views.keys())
							if (!live.sessions.some((session) => session.name === name)) live.views.delete(name);
						void this.save().catch(() => {});
						this.changed();
						if (message.type === "hello") finish();
						return;
					}
					// Invalidate catalogs; each client reloads from its selected machine.
					if ("type" in message && (message.type === "personas" || message.type === "models_changed")) { this.emit(message); return; }
					if ("channel" in message && message.channel === "view") {
						if ("view" in message) live.views.set(message.session, message);
						else {
							const previous = live.views.get(message.session);
							if (previous && "channel" in previous && "view" in previous)
								live.views.set(message.session, {
									channel: "view",
									session: message.session,
									version: message.version,
									view: { ...previous.view, ...message.patch },
								});
						}
					}
					this.emit(mapRemoteFrame(id, message));
				} catch {
					this.notify(id, live.status, "Dropped an invalid remote frame");
				}
			});
			socket.addEventListener("error", () => {
				finish(new Error("Remote WebSocket connection failed"));
				socket.close();
			});
			socket.addEventListener("close", () => {
				finish(new Error("Remote service disconnected"));
				this.lost(id, generation);
			});
		});
	}

	frames(): ServerMessage[] {
		return this.connections.flatMap((row) => [...this.runtime(row.id).views.values()].map((frame) => mapRemoteFrame(row.id, frame)));
	}

	async route(message: ClientMessage): Promise<boolean> {
		// Which session this op is about: a fork names its source under `from`, and its own name is
		// the one the other machine picks when the client did not.
		const name =
			"session" in message
				? message.session
				: message.op === "session.fork"
					? message.from
					: "name" in message && message.name !== undefined
						? message.name
						: "";
		const remote = parseRemoteSession(name);
		const id = message.op === "session.create" ? message.remoteId : remote?.connectionId;
		if (!id) {
			if (name.startsWith("remote:")) throw new Error("Invalid remote session identity");
			return false;
		}
		this.config(id);
		const live = this.runtime(id);
		if (message.op === "resync") {
			const cached = live.views.get(remote!.session);
			if (cached) this.emit(mapRemoteFrame(id, cached));
			if (live.status !== "connected") return true;
		}
		if (live.status !== "connected" || live.socket?.readyState !== 1)
			throw new Error("That machine is not connected right now; nothing was sent. Reconnect and try again.");
		if (message.op === "session.create" || message.op === "modelSet") {
			const generation = live.generation;
			const response = await this.fetch(id, "/api/models");
			if (!response.ok) throw new Error(`Could not read the model configuration on ${this.config(id).name}`);
			const catalog = await response.json() as { models?: { id: string }[] };
			if (!catalog.models?.length) throw new Error(`Configure models on ${this.config(id).name} before creating or switching a remote session. Local models are not used.`);
			if (message.modelId !== undefined && !catalog.models.some((model) => model.id === message.modelId))
				throw new Error(`Model ${message.modelId} is not configured on ${this.config(id).name}`);
			if (live.generation !== generation || live.status !== "connected") throw new Error("Remote connection changed; nothing was sent");
		}
		let outgoing: ClientMessage = message;
		if (remote)
			outgoing =
				message.op === "session.fork"
					? { ...message, from: remote.session }
					: ({ ...message, ...("session" in message ? { session: remote.session } : { name: remote.session }) } as ClientMessage);
		if (outgoing.op === "session.create") {
			const { remoteId: _, ...create } = outgoing;
			if (!create.cwd?.trim()) throw new Error("Choose a workspace directory on that machine");
			outgoing = create;
			await this.addProject(id, create.cwd);
		}
		live.socket.send(JSON.stringify(outgoing));
		return true;
	}

	async fetch(id: string, path: string, init: RequestInit = {}, connecting = false): Promise<Response> {
		this.config(id);
		const live = this.runtime(id);
		if (!live.base || (!connecting && live.status !== "connected")) throw new Error("That machine is not connected");
		const pathname = path.split("?")[0] ?? path;
		if (!pathname.startsWith("/api/") || pathname.startsWith("/api/remotes")) throw new Error("Invalid remote API path");
		const headers = new Headers(init.headers);
		headers.set("authorization", `Bearer ${live.token}`);
		headers.delete("origin");
		headers.delete("host");
		return fetch(`${live.base}${path}`, {
			...init,
			headers,
			redirect: "error",
			signal: init.signal ?? AbortSignal.timeout(60_000),
		});
	}

	terminal(id: string): WebSocket {
		this.config(id);
		const live = this.runtime(id);
		if (live.status !== "connected" || !live.base) throw new Error("That machine is not connected");
		return new RemoteWebSocket(`${live.base.replace("http:", "ws:")}/term`, {
			headers: { authorization: `Bearer ${live.token}` },
		});
	}

	async addProject(id: string, path: string): Promise<void> {
		if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096 || path.includes("\0"))
			throw new Error("Choose an absolute directory on that machine");
		const connection = this.config(id);
		if (!connection.projects.includes(path)) {
			connection.projects.push(path);
			await this.save();
			this.changed();
		}
	}

	async removeProject(id: string, path: string): Promise<void> {
		const connection = this.config(id);
		connection.projects = connection.projects.filter((project) => project !== path);
		await this.save();
		this.changed();
	}

	async forward(id: string, remotePort: number, localPort = 0): Promise<void> {
		if (!validPort(remotePort) || (localPort !== 0 && !validPort(localPort))) throw new Error("Invalid TCP port");
		const connection = this.config(id);
		if (connection.forwards.some((port) => port.remotePort === remotePort)) throw new Error("Port is already forwarded");
		const forward = { id: crypto.randomUUID(), remotePort, localPort };
		connection.forwards.push(forward);
		try {
			await this.startForward(id, forward.id);
			await this.save();
		} catch (error) {
			connection.forwards = connection.forwards.filter((row) => row !== forward);
			throw error;
		}
	}

	private async startForward(id: string, portId: string): Promise<void> {
		const connection = this.config(id);
		const live = this.runtime(id);
		if (live.status !== "connected") throw new Error("Connect the machine before forwarding ports");
		const forward = connection.forwards.find((row) => row.id === portId)!;
		const tunnel = await this.transport.openTunnel(connection, forward.remotePort, forward.localPort || undefined);
		const port = tunnel.localPort;
		live.ports.set(portId, { proc: tunnel.process, port });
		void tunnel.process.exited.then(() => {
			if (live.ports.get(portId)?.proc === tunnel.process) {
				live.ports.delete(portId);
				this.changed();
			}
		});
		await Bun.sleep(400);
		if (tunnel.process.exitCode !== null) throw new Error("Port forwarding failed. Check the local port and SSH configuration.");
		this.changed();
	}

	async removeForward(id: string, portId: string): Promise<void> {
		const connection = this.config(id);
		const live = this.runtime(id);
		live.ports.get(portId)?.proc.kill();
		live.ports.delete(portId);
		connection.forwards = connection.forwards.filter((row) => row.id !== portId);
		await this.save();
		this.changed();
	}

	private async withTunnel<T>(connection: RemoteConnection, remotePort: number, run: (base: string, token: string, descriptor: BackendDescriptor) => Promise<T>): Promise<T> {
		const descriptor = await this.readDescriptor(connection);
		if (descriptor === undefined) throw new RemoteError("no-service", `No eta backend is running on ${connection.host}`);
		const tunnel = await this.transport.openTunnel(connection, remotePort);
		try {
			const base = `http://127.0.0.1:${String(tunnel.localPort)}`;
			return await run(base, descriptor.token, descriptor);
		} finally {
			tunnel.process.kill();
		}
	}

	/**
	 * Stop the service that owns that machine. Different from disconnecting: it ends
	 * somebody's backend, which may be the window they are looking at over there, so
	 * the backend refuses while sessions are running and the caller must confirm.
	 */
	async stop(id: string, confirm = false): Promise<void> {
		if (confirm !== true) throw new Error("Stopping the machine's service needs an explicit confirmation");
		const connection = this.config(id);
		const live = this.runtime(id);
		const descriptor = await this.readDescriptor(connection);
		if (descriptor === undefined) {
			this.disconnect(id);
			return;
		}
		this.notify(id, "checking", "Asking that machine to stop its eta service (running sessions are checked there).");
		const result = await this.withTunnel(connection, descriptor.port, async (base, token) => {
			const response = await fetch(`${base}/api/service/stop`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: "{}",
				signal: AbortSignal.timeout(8000),
			});
			return { ok: response.ok, message: response.ok ? "" : (await response.text()).slice(0, 300) };
		});
		if (!result.ok) throw new RemoteError("busy", result.message || "The service refused to stop");
		live.logs = [...live.logs, `${new Date().toISOString()} Service stopped on ${connection.host}.`].slice(-60);
		this.disconnect(id);
	}


	close(): void {
		this.closed = true;
		for (const id of [...this.live.keys()]) this.disconnect(id);
	}
}

export function mapRemoteFrame(id: string, message: ServerMessage): ServerMessage {
	if ("channel" in message && message.channel === "dev")
		return { ...message, frame: { ...message.frame, session: remoteSessionName(id, message.frame.session) } };
	if ("session" in message) return { ...message, session: remoteSessionName(id, message.session) };
	if ("type" in message && (message.type === "created" || message.type === "deleted"))
		return { ...message, name: remoteSessionName(id, message.name) };
	if ("type" in message && message.type === "error") return { ...message, message: `[remote] ${message.message}` };
	return message;
}

function validPort(port: unknown): port is number {
	return Number.isInteger(port) && Number(port) > 0 && Number(port) <= 65535;
}

export function validateConnection(input: unknown): RemoteConnection {
	if (!input || typeof input !== "object") throw new Error("Invalid SSH connection");
	const row = input as Record<string, unknown>;
	const id = row.id ?? crypto.randomUUID();
	if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error("Invalid connection ID");
	if (typeof row.name !== "string" || !row.name.trim() || row.name.length > 100) throw new Error("A connection name is required");
	if (typeof row.host !== "string" || !validHost(row.host))
		throw new Error("Use an SSH host alias or hostname, not an SSH command");
	if (row.user !== undefined && (typeof row.user !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/.test(row.user)))
		throw new Error("Invalid SSH username");
	if (row.port !== undefined && !validPort(row.port)) throw new Error("Invalid SSH port");
	if (
		row.identityFile !== undefined &&
		(typeof row.identityFile !== "string" || !/^(\/|~\/)/.test(row.identityFile) || /[\r\n\0]/.test(row.identityFile))
	)
		throw new Error("Use an absolute private key path");
	const projects = Array.isArray(row.projects)
		? row.projects.filter(
				(path): path is string => typeof path === "string" && path.startsWith("/") && !path.includes("\0") && path.length < 4096,
			)
		: [];
	const forwards = Array.isArray(row.forwards)
		? row.forwards.map((port: Record<string, unknown>) => {
				if (!port || typeof port.id !== "string" || !validPort(port.remotePort) || (port.localPort !== 0 && !validPort(port.localPort)))
					throw new Error("Invalid saved port forward");
				return { id: port.id, remotePort: port.remotePort, localPort: Number(port.localPort) };
			})
		: [];
	return {
		id,
		name: row.name.trim(),
		host: row.host,
		...(row.user ? { user: row.user as string } : {}),
		...(row.port ? { port: row.port as number } : {}),
		...(row.identityFile ? { identityFile: row.identityFile as string } : {}),
		autoConnect: row.autoConnect === true,
		projects,
		forwards,
	};
}
