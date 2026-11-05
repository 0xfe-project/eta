/**
 * The entry point: start the host, or register it as the user's service.
 *
 *   eta-host install-service [flags]   run with these flags at login (systemd user unit, launchd
 *                                       agent), and now; again replaces the flags and restarts
 *   eta-host uninstall-service
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
import { installedEnv, installService, uninstallService } from "@eta/daemon";
import { startHost } from "./host";
import { Tailscale } from "./machines/tailscale";
import { COMPILED, embeddedFiles } from "./resources";

/** The host as a user service: one per user, like the daemon. */
const HOST_UNIT = { name: "io.eta.host", description: "eta host", args: [] };

// `install-service` and `uninstall-service` come first; every other argument is a flag of the run.
const [command, ...rest] = process.argv.slice(2);
const serviceCommand =
  command === "install-service" || command === "uninstall-service"
    ? command
    : undefined;
const flags = serviceCommand === undefined ? process.argv.slice(2) : rest;

const { values } = parseArgs({
  args: flags,
  options: {
    port: { type: "string", default: "8787" },
    host: { type: "string", default: "127.0.0.1" },
    "web-dir": { type: "string" },
    "token-file": { type: "string" },
    "allow-origin": { type: "string", multiple: true },
    "memory-url": { type: "string" },
    "public-url": { type: "string" },
    "no-llm": { type: "boolean", default: false },
    // The GitHub chain is opt-in; `--no-github` overrides an environment that turns it on.
    github: { type: "boolean", default: false },
    "no-github": { type: "boolean", default: false },
    // web_fetch and web_search are on; the search runs on the host's own SearXNG unless given one.
    "no-web": { type: "boolean", default: false },
    "searxng-url": { type: "string" },
  },
  strict: true,
});

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
  if (serviceCommand === "uninstall-service") {
    const definition = await uninstallService(self, HOST_UNIT);
    console.log(`Removed ${definition.name}.`);
  } else {
    const definition = await installService(self, {
      ...HOST_UNIT,
      env: installedEnv(),
    });
    console.log(`Installed ${definition.name} (${definition.path}).`);
    console.log(
      values.host === "127.0.0.1" || values.host === "localhost"
        ? `It listens on http://127.0.0.1:${port}.`
        : `It asks for a token beyond loopback: open the page once with ?token=<the token in ${join(homedir(), ".eta", "access-token")}>.`,
    );
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
  dataDir: join(homedir(), ".eta"),
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

/** A signal is a shutdown, not a crash: the sessions flush, the files close. */
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void host.close().then(() => process.exit(0));
  });
}
