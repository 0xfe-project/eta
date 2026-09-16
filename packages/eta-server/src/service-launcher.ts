import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { backendRunFile, isClaim, isDescriptor, type BackendDescriptor } from "@eta/core/remote";
import { pidAlive, probeBackend, readRunFile } from "./service.ts";

/** Desktop is a client. Only the detached child may claim and open the session store. */
export async function ensureBackend(options: {
	command: string[];
	home?: string;
	webDist?: string;
	version?: string;
	timeoutMs?: number;
}): Promise<BackendDescriptor> {
	const home = options.home ?? homedir();
	const runFile = backendRunFile(home);
	const logPath = join(home, ".eta", "server.log");
	const deadline = Date.now() + (options.timeoutMs ?? 30_000);
	let launched = false;
	let exited: number | null | undefined;
	let spawnError: Error | undefined;
	while (Date.now() < deadline) {
		const raw = await readRunFile(runFile);
		if (isDescriptor(raw) && pidAlive(raw.pid)) {
			const health = await probeBackend(raw);
			if (!health.ok) throw new Error(`The running eta backend cannot be reused: ${health.reason}`);
			return raw;
		}
		if (spawnError) throw spawnError;
		if (exited !== undefined && exited !== 0) throw new Error(`Eta backend exited (${String(exited)}). See ${logPath}`);
		if (!launched && !(isClaim(raw) && pidAlive(raw.pid))) {
			await mkdir(join(home, ".eta"), { recursive: true, mode: 0o700 });
			const log = await open(logPath, "a", 0o600);
			try {
				const child = spawn(options.command[0]!, options.command.slice(1), {
					detached: true,
					cwd: home,
					stdio: ["ignore", log.fd, log.fd],
					env: {
						...process.env,
						ETA_SERVICE_HOME: home,
						...(options.webDist === undefined ? {} : { ETA_WEB_DIST: options.webDist }),
						...(options.version === undefined ? {} : { ETA_VERSION: options.version }),
					},
				});
				child.once("error", (error) => { spawnError = error; });
				child.once("exit", (code) => { exited = code; });
				child.unref();
				launched = true;
			} finally { await log.close(); }
		}
		await Bun.sleep(100);
	}
	throw new Error(`Eta backend did not become ready. See ${logPath}`);
}
