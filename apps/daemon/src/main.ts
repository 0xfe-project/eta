/* eslint-disable antfu/no-top-level-await, no-console -- the entry point of a program, not a module */
import type { ServiceCommand } from "./service";
/**
 * The daemon's command line.
 *
 *   eta-daemon setup <primary-url> <code> [--no-wait]
 *                                            trade an install code for a place on the primary
 *   eta-daemon run                           serve the primary (the default)
 *   eta-daemon install-service               run at login as a systemd user unit or launchd agent
 *   eta-daemon uninstall-service
 *   eta-daemon version                       print the build
 *
 * One file once built (`bun build --compile`): the sessions, their journals and the one
 * credential live in `$HOME/.eta/daemon`. There is no web, no database and no provider
 * configuration here: models and product tools are the primary's.
 *
 * `$HOME` is the only thing that picks the location, on purpose. The daemon used to have a tree of
 * its own (`~/.eta-daemon`) while reading `~/.eta/mcp.json` and the user's persona cards out of
 * the other one — two roots on one machine, the shape that keeps making "where did my data go"
 * questions. It refuses to start on the old directory rather than treat it as empty: a machine
 * that moved silently would just be a machine with no sessions.
 */
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { DaemonLink } from "./client";
import { enroll } from "./enroll";
import {
  defaultDataDir,
  groupFingerprint,
  legacyDataDir,
  loadIdentity,
} from "./identity";
import { DaemonNode } from "./node";
import {
  DAEMON_UNIT,
  installedEnv,
  installService,
  uninstallService,
} from "./service";
import { RESTART_EXIT, settleUpgrade, upgrade } from "./upgrade";
import { VERSION } from "./version";

const { positionals, values } = parseArgs({
  options: {
    // `setup` returns once registered instead of waiting for the approval: the service that is
    // installed next waits instead (the primary's one-step install does this).
    "no-wait": { type: "boolean", default: false },
  },
  allowPositionals: true,
  strict: true,
});
const dataDir = resolve(defaultDataDir());
const legacyDir = resolve(legacyDataDir());
const [command = "run", ...rest] = positionals;

// What an upgrade runs to see that a new build starts: nothing else is touched.
if (command === "version") {
  console.log(VERSION);
  process.exit(0);
}

// An older daemon kept its identity and sessions here. Starting on an empty directory instead
// would look like a machine that had never been set up — and the sessions would be gone from the
// primary's point of view while still sitting on disk.
if (existsSync(legacyDir) && !existsSync(dataDir)) {
  console.error(
    [
      `${legacyDir} is where an older eta-daemon kept its data.`,
      `This one uses ${dataDir}. Move it before starting:`,
      "",
      `  mkdir -p "$HOME/.eta" && mv "$HOME/.eta-daemon" "$HOME/.eta/daemon"`,
      "",
      "A service registered by an older version points at the old directory:",
      "uninstall it with that version first (`eta-daemon uninstall-service`),",
      "then register again with this one.",
    ].join("\n"),
  );
  process.exit(2);
}

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
  if (values["no-wait"] === true) return;
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
  let closing = false;
  let node: DaemonNode | undefined;
  let link: DaemonLink | undefined;
  let settled: ReturnType<typeof settleUpgrade> | undefined;
  // Stop serving and leave; a code other than 0 is a request for the service manager to start
  // this file again (which, after an upgrade or a roll-back, is another build).
  const leave = (code: number): void => {
    if (closing) return;
    closing = true;
    settled?.dispose();
    void Promise.resolve(link?.stop())
      .then(() => node?.close())
      .then(() => process.exit(code));
  };
  // A build that was just swapped in has to get back in, or the old one is put back.
  settled = settleUpgrade({
    dataDir,
    version: VERSION,
    rollBack: () => leave(RESTART_EXIT),
    warn: (message) => console.error(message),
  });
  if (closing) return;
  node = new DaemonNode({
    dataDir,
    version: VERSION,
    upgrade: async (wanted) => {
      const done = await upgrade(wanted, {
        identity,
        dataDir,
        version: VERSION,
      });
      // The answer has to reach the primary before the link goes.
      if (done.ok) setTimeout(leave, 500, RESTART_EXIT);
      return done;
    },
  });
  await node.start();
  link = new DaemonLink({
    identity,
    server: node,
    onState: (state) => {
      if (state.state === "online") settled?.admitted();
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
    JSON.stringify({
      pid: process.pid,
      dataDir,
      primary: identity.url,
      version: VERSION,
    }),
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => leave(0));
}

switch (command) {
  case "setup":
    await setup();
    break;
  case "run":
    await run();
    break;
  case "install-service": {
    const definition = await installService(selfCommand(), {
      ...DAEMON_UNIT,
      env: installedEnv(),
    });
    console.log(`Installed ${definition.name} (${definition.path}).`);
    break;
  }
  case "uninstall-service": {
    const definition = await uninstallService(selfCommand());
    console.log(`Removed ${definition.name}.`);
    break;
  }
  default:
    console.error(`unknown command: ${command}`);
    process.exit(2);
}
