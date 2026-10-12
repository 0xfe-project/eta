/**
 * The entry point: start the server.
 *
 * A thin shell around `assembleServer` — argument parsing, a signal handler, and the one thing
 * an assembly cannot do for itself: knowing where its data directory is.
 *
 *   bun packages/eta-server/src/main.ts --data-dir ~/.eta --port 8787
 *
 * Everything else is defaults: `~/.eta/config.json` for providers, `<data-dir>/settings.json`
 * for the defaults new sessions inherit, `<data-dir>/sessions/<id>/` for the sessions themselves.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createLocalEnvironment } from "@eta/execution-node";
import { assembleServer } from "./server";

function argument(name: string, fallback: string): string {
	const index = process.argv.indexOf(`--${name}`);
	const value = index === -1 ? undefined : process.argv[index + 1];
	return value ?? fallback;
}

const dataDir = argument("data-dir", join(homedir(), ".eta"));
const port = Number(argument("port", "8787"));
const configPath = argument("config", join(dataDir, "config.json"));

const server = await assembleServer({
	dataDir,
	configPath,
	port,
	// The file and shell tools a session runs: the local Node adapter, when this runtime can
	// host it (Node, or Bun/Deno in Node-compatibility mode). Without one a session still
	// works — it simply has no read/write/edit/bash, which is a session, not a failure.
	envFor: (meta) => {
		const env = createLocalEnvironment(meta.cwd);
		return env === undefined ? undefined : { env };
	},
});
const hello = {
	port: server.server.port,
	dataDir,
	configPath,
	plugins: server
		.mounted()
		.map((plugin) => (plugin.error === undefined ? plugin.name : `${plugin.name} (${plugin.error})`)),
};
console.log(JSON.stringify(hello, null, 2));

/** A signal is a shutdown, not a crash: the sessions flush and the files close. */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		void server.close().then(() => process.exit(0));
	});
}
