/**
 * Stage the host a packaged app carries: `dist/host/`, which `electrobun.config.ts` copies into
 * the bundle as `host/`.
 *
 * The host (`apps/eta`) compiled to one executable, `eta-host`, and beside it, flat, the files it
 * reads at run time (`apps/eta/src/resources.ts` is where it looks):
 *
 *   eta-host        the host itself
 *   migrations/     apps/eta/src/migrations
 *   bundles/        the built-in bundles
 *   Eta-Logo.png    the logo the mail template embeds
 *   web/            apps/web/dist, the page (built first: `bun run --cwd apps/web build`)
 *   cli-proxy-api   CLIProxyAPI for this platform, and `cpa-launcher` next to it
 *   daemon/         eta-daemon for every platform, with its manifest
 *
 * The cpajs platform packages are external to the bundle: their table names every platform, the
 * install has one, and the compiled host is handed its binary by path instead.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { $ } from "bun";

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

const externals = [
  "darwin",
  "win32",
  "linux",
  "freebsd",
  "openbsd",
  "netbsd",
].flatMap((os) => ["--external", `@cpajs/${os}-*`]);
await $`bun build --compile --target=bun ${externals} ${join(app, "src", "main.ts")} --outfile ${join(out, "eta-host")}`;

cpSync(join(app, "src", "migrations"), join(out, "migrations"), {
  recursive: true,
});
cpSync(join(root, "bundles"), join(out, "bundles"), { recursive: true });
cpSync(
  join(root, "apps", "web", "public", "Eta-Logo.png"),
  join(out, "Eta-Logo.png"),
);
cpSync(web, join(out, "web"), { recursive: true });

// The daemon for every platform it runs on: what this host keeps its machines at and installs new
// ones from (`apps/eta/src/machines/builds.ts`).
await $`bun run --cwd ${join(root, "apps", "daemon")} build:all`;
cpSync(join(root, "apps", "daemon", "out", "dist"), join(out, "daemon"), {
  recursive: true,
});

// cpajs's own lookup, from where the host resolves it: the binary of the installed platform.
const server = (await import(Bun.resolveSync("@cpajs/cpa/server", app))) as {
  resolveBinary: () => { path: string };
};
const cpa = server.resolveBinary().path;
cpSync(cpa, join(out, "cli-proxy-api"));
const launcher = join(dirname(cpa), "cpa-launcher");
if (existsSync(launcher)) cpSync(launcher, join(out, "cpa-launcher"));

console.log(`staged the host in ${out}`);
