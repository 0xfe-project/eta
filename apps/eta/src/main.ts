/**
 * The entry point: start the host, or register it as the user's service.
 *
 *   eta-host --version                 the version and commit it was built from, and nothing else
 *   eta-host install-service [flags]   run with these flags at login (systemd user unit, launchd
 *                                       agent) or boot (Windows service), and now; again replaces
 *                                       the flags and restarts
 *   eta-host uninstall-service
 *   eta-host upgrade [version]         replace this file with a release (`upgrade/command.ts`)
 *   eta-host running                   the host already serving ~/.eta, as one line of JSON, or
 *                                      `null` (`running.ts`): what the desktop app asks first
 *   eta-host --help                    the usage; a flag it does not know gets it too, on stderr
 *
 *   bun apps/eta/src/main.ts [--port 8787] [--host 127.0.0.1]
 *                            [--web-dir <built web>] [--token-file <path>]
 *                            [--allow-origin <origin>]... [--memory-url <sidecar>] [--no-llm]
 *                            [--github] [--public-url <the address the browser uses>]
 *                            [--no-web] [--searxng-url <a SearXNG of your own>]
 *
 * A thin shell around `startHost`: flags, a startup summary on one line, and a signal handler.
 * Everything the host serves lives behind the one port; `--web-dir` adds the page, and a host
 * that listens beyond loopback (or is given a `--token-file`) asks for a token first.
 * `--host tailscale` listens on this computer's tailnet address, which is how the other computers
 * of the tailnet reach it (and the address they are told to dial when added as machines).
 *
 * A compiled host serves the page it carries (`resources.ts`) unless told another `--web-dir`.
 *
 * The data directory is `~/.eta` and is not a flag. A second one was a second half: personas went
 * on being read from the real home while the config came from somewhere else, so a process pointed
 * at another directory looked like a config that had gone missing. One root, `$HOME` decides it.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { installedEnv } from "@eta/daemon";
import { parseFailure, RUN_OPTIONS, USAGE } from "./cli";
import { loadMigrations } from "./db";
import { startHost } from "./host";
import { Tailscale } from "./machines/tailscale";
import { COMPILED, embeddedFiles } from "./resources";
import { findRunningHost, recordRunning } from "./running";
import { listenForStop } from "./stop";
import { upgradeCommand } from "./upgrade/command";
import { takeDesktopShell } from "./upgrade/desktop";
import { HOST_UNIT, hostManager } from "./upgrade/service";
import { VERSION, VERSION_JSON, VERSION_LINE } from "./version";

// Before anything can start a process that would inherit it.
takeDesktopShell();

const dataDir = join(homedir(), ".eta");

// A subcommand comes first; every other argument is a flag of the run.
const [command, ...rest] = process.argv.slice(2);
if (command === "upgrade") process.exit(await upgradeCommand(rest));
if (command === "running") {
  console.log(JSON.stringify((await findRunningHost({ dataDir })) ?? null));
  process.exit(0);
}
const serviceCommand =
  command === "install-service" || command === "uninstall-service"
    ? command
    : undefined;
const flags = serviceCommand === undefined ? process.argv.slice(2) : rest;

function parseFlags() {
  try {
    return parseArgs({ args: flags, options: RUN_OPTIONS, strict: true });
  } catch (error) {
    console.error(`eta-host: ${parseFailure(error)}\n\n${USAGE}`);
    process.exit(2);
  }
}

const { values } = parseFlags();

if (values.help === true) {
  console.log(USAGE);
  process.exit(0);
}

if (values.version === true) {
  console.log(values.json === true ? VERSION_JSON : VERSION_LINE);
  process.exit(0);
}

if (values.migrations === true) {
  for (const { id } of loadMigrations()) console.log(id);
  process.exit(0);
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  console.error(`--port: not a port: ${values.port}`);
  process.exit(2);
}

if (serviceCommand !== undefined) {
  // How this process was started, for a service that has to start it again: a compiled host is
  // its own program; from source it is bun and this file. The flags were checked above.
  const self = COMPILED
    ? { program: process.execPath, args: flags }
    : { program: process.execPath, args: [Bun.main, ...flags] };
  if (process.platform === "win32" && !COMPILED) {
    console.error(
      `eta-host ${serviceCommand}: a Windows service runs a compiled host, and this one runs from source`,
    );
    process.exit(1);
  }
  try {
    if (serviceCommand === "uninstall-service") {
      const definition = await hostManager().uninstall(self);
      console.log(`Removed ${definition.name}.`);
    } else {
      const manager = hostManager({ ...HOST_UNIT, env: installedEnv() });
      const definition = await manager.install(self);
      console.log(`Installed ${definition.name} (${definition.path}).`);
      console.log(
        values.host === "127.0.0.1" || values.host === "localhost"
          ? `It listens on http://127.0.0.1:${port}.`
          : `It asks for a token beyond loopback: open the page once with ?token=<the token in ${join(homedir(), ".eta", "access-token")}>.`,
      );
    }
  } catch (error) {
    console.error(
      `eta-host ${serviceCommand}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  process.exit(0);
}

// `tailscale` is not an interface: it is this computer's address on its tailnet, asked for now.
let listen = values.host;
if (listen === "tailscale") {
  const address = await new Tailscale().address();
  if (address === undefined) {
    console.error(
      "--host tailscale: Tailscale is not installed or not up here",
    );
    process.exit(2);
  }
  listen = address;
}

const memoryUrl = values["memory-url"] ?? process.env.ETA_MEMORY_URL;
const publicUrl = values["public-url"] ?? process.env.ETA_PUBLIC_URL;
const searxngUrl = values["searxng-url"] ?? process.env.ETA_SEARXNG_URL;

/** An environment switch: on for `1`, `true`, `yes`, `on`; anything else (or nothing) is off. */
const envOn = (value: string | undefined): boolean =>
  ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());

// Off unless a host asked for it: the flag, or an environment that says so. `--no-github` wins,
// so an operator can switch one off for a single start without editing the environment.
const github =
  values["no-github"] === true
    ? false
    : values.github === true || envOn(process.env.ETA_GITHUB);

const host = await startHost({
  dataDir,
  port,
  hostname: listen,
  // The tailnet's computers can be found and added as machines, and the user's own let in.
  tailscale: true,
  // The daemon builds this host carries (or the checkout's): daemons are kept at them.
  daemonBuilds: true,
  ...(values["web-dir"] === undefined
    ? {}
    : { webDir: resolve(values["web-dir"]) }),
  ...(values["token-file"] === undefined
    ? {}
    : { tokenFile: resolve(values["token-file"]) }),
  allowOrigins: values["allow-origin"] ?? [],
  // Subscriptions and Gemini keys, through the LLM gateway (CLIProxyAPI in a child process).
  llm: values["no-llm"] !== true,
  // The whole GitHub chain, or none of it.
  github,
  // Reading the web, in this process; an empty SearXNG address means the host's own.
  web:
    values["no-web"] === true
      ? false
      : searxngUrl === undefined || searxngUrl === ""
        ? true
        : { searxngUrl },
  // The flag wins over the environment; an empty value means none.
  ...(memoryUrl === undefined || memoryUrl === "" ? {} : { memoryUrl }),
  ...(publicUrl === undefined || publicUrl === "" ? {} : { publicUrl }),
});

console.log(
  JSON.stringify({
    pid: process.pid,
    host: host.hostname,
    port: host.port,
    dataDir: host.dataDir,
    webDir:
      host.webDir ?? (embeddedFiles("web") === undefined ? null : "(embedded)"),
    tokenFile: host.tokenFile ?? null,
    plugins: host.server
      .mounted()
      .map((plugin) =>
        plugin.error === undefined
          ? plugin.name
          : `${plugin.name} (${plugin.error})`,
      ),
  }),
);

// Said where another start looks before it opens the same database (`running.ts`).
const forget = recordRunning(dataDir, {
  pid: process.pid,
  hostname: host.hostname,
  port: host.port,
  tokenFile: host.tokenFile ?? null,
  version: VERSION,
});
process.on("exit", forget);

/** A signal is a shutdown, not a crash: the sessions flush, the files close. */
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    forget();
    void host.close().then(() => process.exit(0));
  });
}
listenForStop();
