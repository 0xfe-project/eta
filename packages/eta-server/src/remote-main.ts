/**
 * The eta backend a machine runs when nobody is looking: started by the local
 * `bun run dev`, by the desktop shell, or by the SSH connection that needs that
 * machine's sessions and providers. One process owns the session space — whoever
 * arrives second reuses the first (see service.ts) instead of writing a second
 * journal over the same files.
 *
 * Subcommands:
 *   serve (default) — claim/reuse, then listen on loopback and print the descriptor.
 *   describe        — print the descriptor of the backend that owns this machine.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { backendRunFile, type BackendDescriptor } from "@eta/core/remote";
import { startServer } from "./server.ts";
import { claimBackend, readDescriptor } from "./service.ts";

const command = process.argv[2] ?? "serve";
const home = process.env.ETA_SERVICE_HOME ?? homedir();

async function describe(): Promise<number> {
	const descriptor = await readDescriptor(backendRunFile(home));
	if (descriptor === undefined) {
		process.stderr.write("no eta backend is running on this machine\n");
		return 1;
	}
	process.stdout.write(`${JSON.stringify(descriptor)}\n`);
	return 0;
}

async function serve(): Promise<number> {
	const runFile = backendRunFile(home);
	// Long grace: the winner may still be restoring a large journal, and waiting for
	// its descriptor is cheaper than starting a second writer over the same files.
	const claim = await claimBackend(runFile, process.pid, 20_000);
	if (claim.kind === "reused") {
		// Hand over the descriptor the caller is waiting for on stdout.
		process.stdout.write(`${JSON.stringify(claim.descriptor)}\n`);
		return 0;
	}
	if (claim.kind === "busy") {
		process.stderr.write(`cannot start eta on this machine: ${claim.reason}\n`);
		return 1;
	}
	const server = await startServer({
		port: 0,
		hostname: "127.0.0.1",
		dataDir: join(home, ".eta", "sessions"),
		configPath: join(home, ".eta", "config.json"),
		...(process.env.ETA_WEB_DIST ? { webDist: process.env.ETA_WEB_DIST } : {}),
		service: { home, role: "service", version: process.env.ETA_VERSION ?? "0.1.0", claim: claim.handle },
	});
	process.stdout.write(`${JSON.stringify(server.descriptor satisfies BackendDescriptor | undefined)}\n`);
	const close = async (): Promise<void> => {
		await server.close();
		process.exit(0);
	};
	process.on("SIGTERM", close);
	process.on("SIGINT", close);
	// Loops and goals keep firing with nobody attached — that is what this process is
	// for, so it simply stays alive until a signal arrives.
	return await new Promise<number>(() => undefined);
}

if (command !== "serve" && command !== "describe") throw new Error(`Unknown command: ${command}`);
const code = command === "describe" ? await describe() : await serve();
process.exit(code);
