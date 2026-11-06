/**
 * Stage the host a packaged app carries: `dist/host/`, which `electrobun.config.ts` copies into
 * the bundle as `host/`.
 *
 * One file, `eta-host`: the host (`apps/eta`) compiled with everything it reads at run time inside
 * it. `apps/eta/scripts/embed.ts` generates the entry that embeds them, and
 * `apps/eta/src/resources.ts` is how the host finds them:
 *
 *   migrations/     apps/eta/src/migrations
 *   Eta-Logo.png    the logo the mail template embeds
 *   web/            apps/web/dist, the page (built first: `bun run --cwd apps/web build`)
 *   cpa/            CLIProxyAPI for this platform, and `cpa-launcher` next to it
 *   daemon/         eta-daemon for every platform, compressed, with its manifest
 *
 * The host is the same build as the daemons it carries: it takes their version from their manifest
 * (`ETA_DAEMON_VERSION`, or what `apps/daemon/scripts/build.ts` makes of the commit) and the commit
 * from git, by `--define` (`apps/eta/src/version.ts`).
 *
 * The cpajs platform packages are external to the bundle: their table names every platform, the
 * install has one, and the compiled host is handed its binary by path instead.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { $ } from "bun";
import { writeEmbedded } from "../../eta/scripts/embed";

const root = resolve(import.meta.dir, "../../..");
const app = join(root, "apps", "eta");
const out = resolve(import.meta.dir, "..", "dist", "host");

const web = join(root, "apps", "web", "dist");
if (!existsSync(join(web, "index.html"))) {
  console.error(
    `no built page at ${web}: run \`bun run --cwd apps/web build\` first`,
  );
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

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
const defines = [
  `ETA_HOST_VERSION=${JSON.stringify(version)}`,
  `ETA_HOST_COMMIT=${JSON.stringify(commit)}`,
].flatMap((define) => ["--define", define]);
await $`bun build --compile --target=bun ${defines} ${externals} ${entry} --outfile ${join(out, "eta-host")}`;

console.log(`staged the host ${version} in ${out}`);
