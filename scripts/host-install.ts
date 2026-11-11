/**
 * Install the host on this computer from the checkout, as the user's service; run again to upgrade.
 *
 *   bun run host:install -- [host flags]     e.g. -- --host tailscale --port 8790
 *
 * 1. builds the page (`apps/web`) and builds the host the way a release ships it
 *    (`apps/eta/scripts/build-host.ts`: one executable with its migrations, page,
 *    CLIProxyAPI, and the daemon for every platform inside);
 * 2. puts it in `~/.local/share/eta/host` (the old directory is swapped out whole, so nothing an
 *    older install laid out there stays behind, and a running host keeps the file it started
 *    from until it restarts);
 * 3. runs `eta-host install-service <flags>` from there, which writes the user service and
 *    restarts it on the new files.
 *
 * The data stays where it always is, `~/.eta`; this only places the program. The daemons the host
 * keeps are replaced with the build it now carries the next time they connect.
 */
import { cpSync, existsSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { $ } from "bun";

const root = resolve(import.meta.dir, "..");
const flags = process.argv.slice(2);
const home = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
  "eta",
);
const target = join(home, "host");
const staged = join(root, "apps", "eta", "out", "host");

await $`${process.execPath} run --cwd ${join(root, "apps", "web")} build`;
await $`${process.execPath} ${join(root, "apps", "eta", "scripts", "build-host.ts")}`;

const next = `${target}.next`;
const previous = `${target}.previous`;
rmSync(next, { recursive: true, force: true });
cpSync(staged, next, { recursive: true });
rmSync(previous, { recursive: true, force: true });
if (existsSync(target)) renameSync(target, previous);
renameSync(next, target);
rmSync(previous, { recursive: true, force: true });

await $`${join(target, "eta-host")} install-service ${flags}`;
console.log(
  `The host is in ${target}; its data in ${join(homedir(), ".eta")}.`,
);
