/* eslint-disable no-console -- a command line */
/** `eta-host upgrade`: its flags, what `--help` says, and an exit code. */
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { parseFailure } from "../cli";
import { COMPILED } from "../resources";
import { VERSION } from "../version";
import { BACKUPS_KEPT } from "./database";
import { Releases } from "./releases";
import { findHostService } from "./service";
import { isReleaseVersion, upgradeHost } from "./upgrade";

const WAIT_MINUTES = 10;

const USAGE = `Usage: eta-host upgrade [version] [--check] [--force] [--wait <minutes>]

Replace this file with a release, the latest full one unless given a version; a pre-release has to
be named (0.2.0-rc.1). The download is checked against SHA256SUMS and run once before anything
changes, and a release older than this build is refused.

If the service (io.eta.host) runs this file, the host is restarted: it waits for working agents,
stops the service, backs up the database, swaps the file, starts it, and checks /up and the
migrations. If that fails, the old build and the database go back and the service is started again.
Otherwise only the file is replaced and restarting is up to you.

  --check             say whether there is something newer and change nothing
  --force             do not wait for agents: the restart stops the ones running
  --wait <minutes>    how long to wait for them, default ${WAIT_MINUTES}; then give up, changing nothing

Database backups: ~/.eta/backups/upgrade-<time>-<old version>.sqlite, the newest ${BACKUPS_KEPT} are kept.
The old build stays beside this file as <file>.prev.

A private repository needs a token: GH_TOKEN, GITHUB_TOKEN, or a logged-in gh.
ETA_RELEASES_URL names another repository's API address, as in
https://api.github.com/repos/<owner>/<repo>.
`;

function fail(what: string): number {
  console.error(`eta-host upgrade: ${what}\n\n${USAGE}`);
  return 2;
}

export async function upgradeCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        check: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        wait: { type: "string", default: String(WAIT_MINUTES) },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return fail(parseFailure(error));
  }
  const { positionals, values } = parsed;
  if (values.help === true) {
    console.log(USAGE);
    return 0;
  }
  if (positionals.length > 1) return fail("one version at a time");
  const wanted = positionals[0]?.replace(/^v/, "");
  if (wanted !== undefined && !isReleaseVersion(wanted))
    return fail(`not a version: ${positionals[0]}`);
  const minutes = Number(values.wait);
  if (!Number.isFinite(minutes) || minutes < 0)
    return fail(`--wait: not a number of minutes: ${values.wait}`);
  if (!COMPILED && values.check !== true) {
    console.error(
      "eta-host upgrade: this host runs from source; update the checkout instead",
    );
    return 1;
  }

  try {
    await upgradeHost({
      wanted,
      check: values.check === true,
      force: values.force === true,
      waitMs: minutes * 60_000,
      version: VERSION,
      execPath: process.execPath,
      dataDir: join(homedir(), ".eta"),
      releases: new Releases({
        ...(process.env.ETA_RELEASES_URL
          ? { url: process.env.ETA_RELEASES_URL }
          : {}),
      }),
      findService: findHostService,
      log: (line) => console.log(line),
    });
    return 0;
  } catch (error) {
    console.error(
      `eta-host upgrade: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
