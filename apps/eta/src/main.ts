/**
 * The entry point: start the host.
 *
 *   bun apps/eta/src/main.ts [--data-dir ~/.eta] [--port 8787] [--host 127.0.0.1] [--config <path>]
 *
 * Everything else is a default: `~/.eta/config.json` for the model services, `~/.eta/plugins`
 * for the user's plugins. Loopback unless asked otherwise — whatever can reach this port can run
 * commands (REFACTOR.md §7.1), which is why binding elsewhere prints a warning.
 *
 * A signal is a shutdown, not a crash: the tree is disposed in reverse and the process exits
 * when it is done.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  codexAuthPath,
  CodexCredentialStore,
  CodexLogin,
  piCodexLogin,
} from "./codex-auth";
import { configuredProviders } from "./config";
import { assembleHost } from "./host";

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value ?? fallback;
}

/**
 * `login codex`: bind a ChatGPT account by device code (P0.6).
 *
 * The front end gets this as an operation in P1; until then the terminal is how an account is
 * bound, and the flow is the same one — pi-ai's OAuth, with its events printed instead of drawn.
 */
async function loginCodex(configPath: string): Promise<void> {
  const credentials = new CodexCredentialStore(codexAuthPath(configPath));
  const flow = new CodexLogin({
    credentials,
    login: piCodexLogin(credentials),
  });
  const view = flow.start("device_code");
  process.stdout.write(
    `[eta] codex login ${view.id}: waiting for the device code\n`,
  );
  let printed = "";
  for (;;) {
    const status = flow.status(view.id);
    if (status.userCode !== undefined && status.url !== undefined) {
      const line = `code ${status.userCode} at ${status.url}`;
      if (line !== printed) {
        printed = line;
        process.stdout.write(`[eta] ${line}\n`);
      }
    }
    if (status.status === "complete") {
      process.stdout.write(
        `[eta] codex login complete; credentials at ${credentials.path}\n`,
      );
      return;
    }
    if (status.status !== "pending") {
      process.stdout.write(`[eta] codex login ${status.status}\n`);
      process.exitCode = 1;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function main(): Promise<void> {
  const dataDir = argument("data-dir", join(homedir(), ".eta"));
  const port = Number(argument("port", "8787"));
  const hostname = argument("host", "127.0.0.1");
  const configPath = argument("config", join(dataDir, "config.json"));

  // A subcommand, before anything is assembled: binding an account is not a server.
  if (process.argv[2] === "login") {
    const what = process.argv[3];
    if (what === "codex") return await loginCodex(configPath);
    throw new Error(`unknown login target: ${String(what)} (try: login codex)`);
  }

  if (
    hostname !== "127.0.0.1" &&
    hostname !== "localhost" &&
    hostname !== "::1"
  ) {
    console.warn(
      `[eta] listening on ${hostname}: anything that can reach this port can run commands here`,
    );
  }

  const host = await assembleHost({
    dataDir,
    configPath,
    port,
    hostname,
    watchIntervalMs: 2_000,
  });

  // The startup summary goes to stdout as one JSON object: it is what a script (and a person
  // reading a log) uses to know which port and which plugins this process came up with.
  process.stdout.write(
    `${JSON.stringify(
      {
        pid: process.pid,
        host: hostname,
        port: host.port,
        dataDir,
        configPath,
        providers: configuredProviders(host.config).map(
          (provider) => provider.id,
        ),
        plugins: host
          .mounted()
          .map((plugin) =>
            plugin.error === undefined
              ? plugin.name
              : `${plugin.name} (${plugin.error})`,
          ),
        routes: host.routes.routes(),
      },
      null,
      2,
    )}\n`,
  );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void host.close().then(() => process.exit(0));
    });
  }
}

main().catch((error: unknown) => {
  console.error(`[eta] ${String(error)}`);
  process.exit(1);
});
