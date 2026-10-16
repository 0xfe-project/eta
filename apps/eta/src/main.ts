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
import { assembleHost } from "./host";

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value ?? fallback;
}

async function main(): Promise<void> {
  const dataDir = argument("data-dir", join(homedir(), ".eta"));
  const port = Number(argument("port", "8787"));
  const hostname = argument("host", "127.0.0.1");
  const configPath = argument("config", join(dataDir, "config.json"));

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
        providers: host.config.providers.map((provider) => provider.id),
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
