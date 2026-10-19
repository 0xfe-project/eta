/* eslint-disable antfu/no-top-level-await, no-console -- the entry point of a program, not a module */
import type { ServiceCommand } from "./service";
import { basename, resolve } from "node:path";
/**
 * The daemon's command line.
 *
 *   eta-daemon setup <primary-url> <code> [--data-dir <dir>]   trade an install code for a place on the primary
 *   eta-daemon run [--data-dir <dir>]                           serve the primary (the default)
 *   eta-daemon install-service [--data-dir <dir>]               run at login as a systemd user unit or launchd agent
 *   eta-daemon uninstall-service [--data-dir <dir>]
 *
 * One file once built (`bun build --compile`): the sessions, their journals and the one
 * credential live in the data directory, `~/.eta-daemon` by default. There is no web, no database
 * and no provider configuration here: models and product tools are the primary's.
 */
import process from "node:process";
import { parseArgs } from "node:util";
import { DaemonLink } from "./client";
import { enroll } from "./enroll";
import { defaultDataDir, groupFingerprint, loadIdentity } from "./identity";
import { DaemonNode } from "./node";
import { installService, uninstallService } from "./service";

const VERSION = "0.1.0";

const { values, positionals } = parseArgs({
  options: { "data-dir": { type: "string" } },
  allowPositionals: true,
  strict: true,
});
const dataDir = resolve(
  values["data-dir"] ?? process.env.ETA_DAEMON_DIR ?? defaultDataDir(),
);
const [command = "run", ...rest] = positionals;

/** How this process was started, for a service that has to start it again. */
function selfCommand(): ServiceCommand {
  // A compiled binary is its own program; run from source it is bun and a script.
  const compiled = !basename(process.execPath).startsWith("bun");
  return compiled
    ? { program: process.execPath, args: [] }
    : { program: process.execPath, args: [Bun.main] };
}

async function setup(): Promise<void> {
  const [url, code] = rest;
  if (url === undefined || code === undefined) {
    console.error("usage: eta-daemon setup <primary-url> <code>");
    process.exit(2);
  }
  const { identity, fingerprint } = await enroll({ dataDir, url, code });
  console.log(`Registered with ${identity.url}.`);
  console.log("");
  console.log(
    "Fingerprint (compare it with the one shown in the primary's settings):",
  );
  console.log(`  ${groupFingerprint(fingerprint)}`);
  console.log("");
  console.log("Waiting for the primary to approve this machine...");
  await new Promise<void>((done) => {
    const link = new DaemonLink({
      identity,
      server: undefined,
      onState: (state) => {
        if (state.state === "online") {
          console.log("Approved.");
          void link.stop().then(done);
        } else if (state.state === "revoked") {
          console.error("The primary refused this machine.");
          process.exit(1);
        }
      },
    });
    link.start();
  });
  console.log(
    "Run `eta-daemon run`, or `eta-daemon install-service` to keep it running.",
  );
}

async function run(): Promise<void> {
  const identity = loadIdentity(dataDir);
  if (identity === undefined) {
    console.error(
      `${dataDir} has no identity: run \`eta-daemon setup <primary-url> <code>\` first`,
    );
    process.exit(2);
  }
  const node = new DaemonNode({ dataDir, version: VERSION });
  await node.start();
  const link = new DaemonLink({
    identity,
    server: node,
    onState: (state) => {
      console.log(
        JSON.stringify({
          link: state.state,
          ...("reason" in state ? { reason: state.reason } : {}),
        }),
      );
    },
  });
  link.start();
  console.log(
    JSON.stringify({ pid: process.pid, dataDir, primary: identity.url }),
  );
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      void link
        .stop()
        .then(() => node.close())
        .then(() => process.exit(0));
    });
  }
}

switch (command) {
  case "setup":
    await setup();
    break;
  case "run":
    await run();
    break;
  case "install-service": {
    const definition = await installService(selfCommand(), dataDir);
    console.log(`Installed ${definition.name} (${definition.path}).`);
    break;
  }
  case "uninstall-service": {
    const definition = await uninstallService(selfCommand(), dataDir);
    console.log(`Removed ${definition.name}.`);
    break;
  }
  default:
    console.error(`unknown command: ${command}`);
    process.exit(2);
}
