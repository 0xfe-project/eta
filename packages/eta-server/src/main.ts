/**
 * `bun run dev` — the machine's eta. It owns this machine's sessions and providers,
 * and a second start (a desktop window, an SSH connection that needs the same
 * sessions) reuses it instead of opening the same journals twice. Set ETA_SERVICE=off
 * for the old behaviour: no run file, no token, nothing shared.
 */
import { startServer, BackendBusyError } from "./server.ts";

const mode = process.env.ETA_SERVICE ?? "claim";
const hostname = process.env.ETA_HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);

if (mode === "off") {
	const plain = await startServer({ port, hostname });
	console.log(`eta-server on http://${hostname}:${plain.port} (model: ${process.env.ANTHROPIC_API_KEY ? "anthropic" : "faux echo"})`);
} else {
	try {
		const server = await startServer({
			port,
			hostname,
			service: { role: "dev", version: "0.1.0" },
		});
		console.log(
			`eta-server on http://${hostname}:${server.port} (model: ${process.env.ANTHROPIC_API_KEY ? "anthropic" : "faux echo"}; sessions ${server.descriptor?.dataDir ?? ""})`,
		);
		const close = async (): Promise<void> => {
			await server.close();
			process.exit(0);
		};
		process.on("SIGTERM", close);
		process.on("SIGINT", close);
	} catch (error) {
		if (error instanceof BackendBusyError) {
			console.error(`eta: ${error.message}`);
			console.error("eta: this machine already has a backend for the same sessions — open that one, stop it, or run with ETA_SERVICE=off to start an isolated instance.");
			process.exit(1);
		}
		throw error;
	}
}
