/**
 * Build the host as a release ships it: `apps/eta/out/host/`, or the directory given.
 *
 *   bun apps/eta/scripts/build-host.ts [out]
 *
 * One file, `eta-host` (`eta-host.exe` on Windows): the host (`apps/eta`) compiled with everything
 * it reads at run time inside it. `apps/eta/scripts/embed.ts` generates the entry that embeds them, and
 * `apps/eta/src/resources.ts` is how the host finds them:
 *
 *   migrations/     apps/eta/src/migrations
 *   Eta-Logo.png    the logo the mail template embeds
 *   web/            apps/web/dist, the page (built first: `bun run --cwd apps/web build`), and
 *                   THIRD_PARTY_NOTICES.md, written here next to it
 *   cpa/            CLIProxyAPI for this platform, and `cpa-launcher` next to it
 *   daemon/         eta-daemon for every platform, compressed, with its manifest
 *
 * The host is the same build as the daemons it carries: it takes their version from their manifest
 * (`ETA_DAEMON_VERSION`, or what `apps/daemon/scripts/build.ts` makes of the commit) and the commit
 * from git, by `--define` (`apps/eta/src/version.ts`). `ETA_HOST_UPSTREAM` is the repository the
 * build takes its upgrades from (`apps/eta/src/upgrade/upstream.ts`): `release.yml` names its own,
 * which is how a fork's builds come to follow the fork.
 *
 * The cpajs platform packages are external to the bundle: their table names every platform, the
 * install has one, and the compiled host is handed its binary by path instead.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { $ } from "bun";
import { parseUpstream } from "../src/upgrade/upstream";
import { writeEmbedded } from "./embed";
import { thirdPartyNotices } from "./notices";

const root = resolve(import.meta.dir, "../../..");
const app = join(root, "apps", "eta");
const out = resolve(process.argv[2] ?? join(app, "out", "host"));

const web = join(root, "apps", "web", "dist");
if (!existsSync(join(web, "index.html"))) {
  console.error(
    `no built page at ${web}: run \`bun run --cwd apps/web build\` first`,
  );
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// With the page, so the one file carries its notices and the host serves them.
writeFileSync(join(web, "THIRD_PARTY_NOTICES.md"), thirdPartyNotices(root));

// The daemon for every platform it runs on: what this host keeps its machines at and installs new
// ones from (`apps/eta/src/machines/builds.ts`).
await $`bun run --cwd ${join(root, "apps", "daemon")} build:all`;
const daemons = join(root, "apps", "daemon", "out", "dist");
const { version } = JSON.parse(
  readFileSync(join(daemons, "manifest.json"), "utf8"),
) as { version: string };
const commit = (
  await $`git rev-parse --short=12 HEAD`.cwd(root).quiet().nothrow()
).stdout
  .toString()
  .trim();

// cpajs's own lookup, from where the host resolves it: the binary of the installed platform.
const server = (await import(Bun.resolveSync("@cpajs/cpa/server", app))) as {
  resolveBinary: () => { path: string };
};
const cpa = server.resolveBinary().path;
const launcher = join(dirname(cpa), "cpa-launcher");

const entry = await writeEmbedded({
  out: join(app, "out", "embed"),
  web,
  daemons,
  cpa: existsSync(launcher) ? [cpa, launcher] : [cpa],
});

const externals = [
  "darwin",
  "win32",
  "linux",
  "freebsd",
  "openbsd",
  "netbsd",
].flatMap((os) => ["--external", `@cpajs/${os}-*`]);
const upstream = process.env.ETA_HOST_UPSTREAM?.trim();
const defines = [
  `ETA_HOST_VERSION=${JSON.stringify(version)}`,
  `ETA_HOST_COMMIT=${JSON.stringify(commit)}`,
  // Read now: a build that cannot upgrade would only find out in the field.
  ...(upstream
    ? [`ETA_HOST_UPSTREAM=${JSON.stringify(parseUpstream(upstream).api)}`]
    : []),
].flatMap((define) => ["--define", define]);
const outfile = process.platform === "win32" ? "eta-host.exe" : "eta-host";
await $`bun build --compile --target=bun ${defines} ${externals} ${entry} --outfile ${join(out, outfile)}`;

console.log(`built the host ${version} in ${out}`);
