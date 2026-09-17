/**
 * The machine's own eta backend, described once and shared by everyone who talks to
 * it: the local page, the desktop shell, and the laptop that arrives over SSH.
 *
 * Public remote metadata only. SSH credentials and service tokens are never part of
 * what the client sees; the descriptor below travels on the machine it belongs to
 * (`~/.eta/run.json`, mode 0600) and is read over the same SSH session that already
 * has the user's authority.
 */

export interface RemoteConnection {
	id: string;
	name: string;
	host: string;
	user?: string;
	port?: number;
	identityFile?: string;
	autoConnect: boolean;
	projects: string[];
	forwards: { id: string; remotePort: number; localPort: number }[];
}

export type RemoteStatus = "awaiting-trust" | "disconnected" | "checking" | "installing" | "connecting" | "connected" | "reconnecting" | "error";

/** What the backend on the other side turned out to be. */
export interface RemoteBackend {
	version: string;
	protocol: number;
	pid: number;
	machineId?: string;
	/** True when the connection adopted a backend that was already running. */
	reused: boolean;
	/** Commit-installed artifact on that machine, when one is on disk. */
	installed?: string;
}

export interface RemoteView extends RemoteConnection {
	status: RemoteStatus;
	error?: string;
	version?: string;
	logs: string[];
	ports: { id: string; remotePort: number; localPort: number; active: boolean }[];
	backend?: RemoteBackend;
}

export interface RemoteWorkspace {
	connectionId: string;
	host: string;
	label: string;
	status: RemoteStatus;
}

export interface RemoteDirectory {
	path: string;
	parent: string;
	directories: { name: string; path: string }[];
}

/**
 * Wire contract between a client and the backend it talks to, plus the layout of the
 * file that says a backend exists. Bump the protocol when a client and a backend can
 * no longer understand each other; a mismatch is reported, never "fixed" by killing
 * a service somebody may be using.
 */
export const BACKEND_PROTOCOL = 2;

/** The descriptor a running backend publishes for its own machine. */
export interface BackendDescriptor {
	/** BACKEND_PROTOCOL at the time it started. */
	protocol: number;
	/** Application version, for display and support. */
	version: string;
	pid: number;
	host: string;
	port: number;
	/** Loopback credential; same value the desktop shell hands its window. */
	token: string;
	/** Absolute session space this process owns. */
	dataDir: string;
	/** Absolute provider config this process owns. */
	configPath: string;
	/** Stable id of the machine, so two connections can be told apart from two backends. */
	machineId: string;
	/** What started it, for the log line a person reads. */
	role: "service" | "desktop" | "dev";
	/** True when /api/native/* answers here. */
	native: boolean;
	startedAt: number;
}

/** The placeholder written at claim time, before the port is known. */
export interface BackendClaim {
	state: "starting";
	pid: number;
	startedAt: number;
}

export const etaDir = (home: string): string => `${home}/.eta`;
export const backendRunFile = (home: string): string => `${etaDir(home)}/run.json`;
export const machineFile = (home: string): string => `${etaDir(home)}/machine.json`;

export function isDescriptor(value: unknown): value is BackendDescriptor {
	if (value === null || typeof value !== "object") return false;
	const row = value as Partial<BackendDescriptor>;
	return (
		typeof row.port === "number" &&
		row.port > 0 &&
		row.port <= 65535 &&
		typeof row.token === "string" &&
		row.token.length > 0 &&
		typeof row.pid === "number" &&
		typeof row.protocol === "number" &&
		typeof row.dataDir === "string"
	);
}

export function isClaim(value: unknown): value is BackendClaim {
	return value !== null && typeof value === "object" && (value as BackendClaim).state === "starting";
}

export function remoteSessionName(connectionId: string, session: string): string {
	return `remote:${connectionId}:${encodeURIComponent(session)}`;
}

export function parseRemoteSession(name: string): { connectionId: string; session: string } | undefined {
	const match = /^remote:([a-zA-Z0-9-]+):(.+)$/.exec(name);
	if (!match) return undefined;
	try {
		return { connectionId: match[1]!, session: decodeURIComponent(match[2]!) };
	} catch {
		return undefined;
	}
}

/** One short-lived confirmation of the exact prompt supplied by OpenSSH. */
export interface RemoteHostKey {
	challengeId: string;
	host: string;
	algorithm: string;
	fingerprint: string;
	prompt: string;
}
