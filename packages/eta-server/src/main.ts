import { homedir } from "node:os";
import { join } from "node:path";
/**
 * The entry point: start the server.
 *
 * A thin shell around `assembleServer` — argument parsing, a signal handler, and the one thing
 * an assembly cannot do for itself: knowing where its data directory is.
 *
 *   bun packages/eta-server/src/main.ts --port 8787 [--host 127.0.0.1] [--run-file <path>]
 *
 * `--run-file` makes this process discoverable (service-file.ts): it claims the file before it
 * listens, publishes host/port once it does, and stands down with exit code 3 when a live backend
 * already owns the file — a shell that launches one and finds another running uses that one.
 *
 * Everything else is defaults under `~/.eta`: `config.json` for providers, `settings.json` for the
 * defaults new sessions inherit, `sessions/<id>/` for the sessions themselves. That directory is
 * `$HOME`'s and is not a flag — see apps/eta/src/main.ts for why.
 */
import process from "node:process";
import { SERVICE_PROTOCOL } from "@eta/client-contracts";
import { createLocalEnvironment } from "@eta/execution-node";
import { assembleServer } from "./server";
import { claimServiceFile } from "./service-file";

function optional(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value ?? fallback;
}

const dataDir = join(homedir(), ".eta");
const port = Number(argument("port", "8787"));
// Loopback unless asked otherwise: anything that can reach this port can run commands.
const hostname = argument("host", "127.0.0.1");
const configPath = argument("config", join(dataDir, "config.json"));
const runFile = optional("run-file");

/** Exit code for "a live backend already owns the run file": not a failure, a redirection. */
const ALREADY_RUNNING = 3;
const claim =
  runFile === undefined ? undefined : await claimServiceFile(runFile);
if (claim?.kind === "taken") {
  const owner = claim.owner;
  console.error(
    owner.state === "ready"
      ? `[eta-server] already running: pid ${owner.pid} on ${owner.host}:${owner.port} (${runFile})`
      : `[eta-server] another backend (pid ${owner.pid}) is starting (${runFile})`,
  );
  process.exit(ALREADY_RUNNING);
}

const server = await assembleServer({
  dataDir,
  configPath,
  port,
  hostname,
  // The file and shell tools a session runs: the local Node adapter, when this runtime can
  // host it (Node, or Bun/Deno in Node-compatibility mode). Without one a session still
  // works — it simply has no read/write/edit/bash, which is a session, not a failure.
  envFor: (meta) => {
    const env = createLocalEnvironment(meta.cwd);
    return env === undefined ? undefined : { env };
  },
});
const hello = {
  pid: process.pid,
  host: hostname,
  port: server.server.port,
  dataDir,
  configPath,
  plugins: server
    .mounted()
    .map((plugin) =>
      plugin.error === undefined
        ? plugin.name
        : `${plugin.name} (${plugin.error})`,
    ),
};
console.log(JSON.stringify(hello, null, 2));
if (claim?.kind === "claimed") {
  await claim.publish({
    protocol: SERVICE_PROTOCOL,
    host: hostname,
    port: server.server.port,
    dataDir,
    version: process.env.ETA_VERSION ?? "dev",
  });
}

/** A signal is a shutdown, not a crash: the sessions flush, the files close, the run file goes. */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server
      .close()
      .then(() => (claim?.kind === "claimed" ? claim.release() : undefined))
      .then(() => process.exit(0));
  });
}
