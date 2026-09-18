/**
 * One backend per machine, discoverable and never duplicated.
 *
 * proper-lockfile holds the exclusive lock for the backend's lifetime. run.json is
 * only its atomic startup/ready descriptor; an unreadable descriptor never permits
 * removing somebody else's lock. A live owner is never displaced by a timeout.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import lockfile from "proper-lockfile";
import { dirname } from "node:path";
import {
	BACKEND_PROTOCOL,
	isClaim,
	isDescriptor,
	machineFile,
	type BackendClaim,
	type BackendDescriptor,
} from "@eta/core/remote";

export interface ClaimHandle {
	publish(descriptor: BackendDescriptor): Promise<void>;
	release(): Promise<void>;
	/** Same, without awaiting: shutdown paths must have removed the file by the time we exit. */
	releaseSync(): void;
}

export type ClaimOutcome =
	| { kind: "claimed"; handle: ClaimHandle }
	| { kind: "reused"; descriptor: BackendDescriptor }
	| { kind: "busy"; descriptor?: BackendDescriptor; reason: string };

export const TOKEN_PATTERN = /^[a-f0-9]{32,128}$/;

export function newToken(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
}

export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means it exists and belongs to somebody else — still alive.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function readRunFile(runFile: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(runFile, "utf8"));
	} catch {
		return undefined;
	}
}

/** The descriptor in a run file, or undefined when it is a claim, garbage or gone. */
export async function readDescriptor(runFile: string): Promise<BackendDescriptor | undefined> {
	const raw = await readRunFile(runFile);
	return isDescriptor(raw) ? raw : undefined;
}

/** A live process's own description of itself; undefined is "nothing usable there". */
export async function probeBackend(
	descriptor: BackendDescriptor,
	timeoutMs = 1500,
): Promise<{ ok: boolean; reason?: string; protocol?: number; version?: string }> {
	try {
		const response = await fetch(`http://${descriptor.host}:${descriptor.port}/api/health`, {
			headers: { authorization: `Bearer ${descriptor.token}` },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) return { ok: false, reason: `health ${response.status}` };
		const health = (await response.json()) as { protocol?: number; version?: string; pid?: number };
		if (health.pid !== undefined && health.pid !== descriptor.pid) return { ok: false, reason: "port answered for a different process" };
		if (health.protocol !== descriptor.protocol) return { ok: false, reason: `protocol ${String(health.protocol)}` };
		if (descriptor.protocol !== BACKEND_PROTOCOL) return { ok: false, protocol: health.protocol, version: health.version, reason: `protocol ${String(health.protocol)}` };
		return { ok: true, protocol: health.protocol, version: health.version };
	} catch (error) {
		return { ok: false, reason: error instanceof Error && error.name === "TimeoutError" ? "no answer" : "unreachable" };
	}
}

/** Claim the backend, or wait for its owner to publish a usable descriptor. */
export async function claimBackend(runFile: string, pid = process.pid, graceMs = 4000): Promise<ClaimOutcome> {
	await mkdir(dirname(runFile), { recursive: true, mode: 0o700 });
	const deadline = Date.now() + graceMs;
	const read = (): unknown => {
		try { return JSON.parse(readFileSync(runFile, "utf8")); } catch { return undefined; }
	};
	const alive = (raw: unknown): boolean => (isDescriptor(raw) || isClaim(raw)) && pidAlive(raw.pid);
	for (;;) {
		let raw = read();
		if (!alive(raw)) {
			let unlock: (() => void) | undefined;
			try {
				// Synchronous acquisition + publication leaves no event-loop gap before the
				// starting PID is visible. Crashed locks expire; live PIDs are checked first.
				unlock = lockfile.lockSync(runFile, { realpath: false, stale: 60_000 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
			}
			if (unlock !== undefined) {
				raw = read(); // Another owner may have published since the first read.
				if (alive(raw)) unlock();
				else {
					const temp = `${runFile}.${crypto.randomUUID()}.tmp`;
					let released = false;
					let published = "";
					const publish = (value: BackendClaim | BackendDescriptor): void => {
						if (released) throw new Error("Backend claim is released");
						const text = `${JSON.stringify(value, null, "\t")}\n`;
						try {
							writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
							renameSync(temp, runFile);
							published = text;
						} finally { rmSync(temp, { force: true }); }
					};
					const releaseSync = (): void => {
						if (released) return;
						released = true;
						try {
							try {
								if (readFileSync(runFile, "utf8") === published) rmSync(runFile, { force: true });
							} catch (error) {
								if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
							}
						} finally { unlock(); }
					};
					try { publish({ state: "starting", pid, startedAt: Date.now() }); }
					catch (error) { releaseSync(); throw error; }
					return { kind: "claimed", handle: {
						publish: async (descriptor) => publish(descriptor),
						release: async () => releaseSync(),
						releaseSync,
					} };
				}
			}
		}
		if (isDescriptor(raw) && pidAlive(raw.pid)) {
			if (raw.protocol !== BACKEND_PROTOCOL) return { kind: "busy", descriptor: raw, reason: `protocol ${String(raw.protocol)}` };
			const health = await probeBackend(raw);
			return health.ok ? { kind: "reused", descriptor: raw } : { kind: "busy", descriptor: raw, reason: health.reason ?? "no answer" };
		}
		if (Date.now() >= deadline) return { kind: "busy", reason: "another eta is starting or its lock is recovering" };
		await sleep(Math.min(100, deadline - Date.now()));
	}
}

/** Ask a running backend to stop, the same way the settings page does. */
export async function stopBackend(descriptor: BackendDescriptor, timeoutMs = 4000): Promise<{ ok: boolean; message?: string }> {
	try {
		const response = await fetch(`http://${descriptor.host}:${descriptor.port}/api/service/stop`, {
			method: "POST",
			headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
			body: "{}",
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (response.ok) return { ok: true };
		return { ok: false, message: (await response.text()).slice(0, 400) };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}

/** The machine's stable id, created on first use. Survives backend restarts. */
export async function ensureMachineId(home: string): Promise<string> {
	const path = machineFile(home);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const existing = await readFile(path, "utf8").catch(() => "");
	try {
		const id = (JSON.parse(existing) as { id?: unknown }).id;
		if (typeof id === "string" && /^[a-f0-9-]{8,64}$/.test(id)) return id;
	} catch {
		/* first run or debris */
	}
	const id = crypto.randomUUID();
	await writeFile(path, `${JSON.stringify({ id }, null, "\t")}\n`, { mode: 0o600 }).catch(() => undefined);
	return id;
}
