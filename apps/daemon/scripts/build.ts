/**
 * Build `eta-daemon`: one executable per platform, and a manifest the primary reads.
 *
 *   bun scripts/build.ts          this platform
 *   bun scripts/build.ts --all    every platform a daemon runs on (Linux and macOS, x64 and arm64)
 *
 * Writes `out/dist/eta-daemon-<platform>` and `out/dist/manifest.json`, and copies this platform's
 * build to `out/eta-daemon` (what `eta-daemon setup` is run from by hand). Every build carries the
 * same version (`--define ETA_DAEMON_VERSION`): `ETA_DAEMON_VERSION` from the environment, or the
 * commit, with a stamp when the tree has changes. The primary hands a daemon its build and
 * replaces a daemon that reports another version (`apps/eta/src/machines/builds.ts`).
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { $ } from "bun";

const PLATFORMS = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
] as const;

const root = resolve(import.meta.dir, "..");
const out = join(root, "out");
const dist = join(out, "dist");

async function versionOf(): Promise<string> {
  const given = process.env.ETA_DAEMON_VERSION?.trim();
  if (given !== undefined && given !== "") return given;
  const commit = (
    await $`git rev-parse --short=12 HEAD`.cwd(root).quiet().nothrow()
  ).stdout
    .toString()
    .trim();
  if (commit === "") return `dev.${Date.now().toString(36)}`;
  const dirty = (
    await $`git status --porcelain`.cwd(root).quiet().nothrow()
  ).stdout
    .toString()
    .trim();
  return dirty === "" ? commit : `${commit}-dirty.${Date.now().toString(36)}`;
}

const here = `${process.platform}-${process.arch}`;
const all = process.argv.includes("--all");
const targets = all ? [...PLATFORMS] : [here];
const version = await versionOf();

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const builds: Record<string, { file: string; sha256: string; size: number }> =
  {};
for (const platform of targets) {
  const file = `eta-daemon-${platform}`;
  const target = `bun-${platform}`;
  // This bun, by path: the same one running the script.
  await $`${process.execPath} build --compile --target=${target} --define ETA_DAEMON_VERSION=${JSON.stringify(version)} src/main.ts --outfile ${join(dist, file)}`.cwd(
    root,
  );
  const bytes = readFileSync(join(dist, file));
  builds[platform] = {
    file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: statSync(join(dist, file)).size,
  };
}
writeFileSync(
  join(dist, "manifest.json"),
  `${JSON.stringify({ version, builds }, null, 2)}\n`,
);
if (builds[here] !== undefined)
  copyFileSync(join(dist, builds[here].file), join(out, "eta-daemon"));
console.log(`eta-daemon ${version}: ${Object.keys(builds).join(", ")}`);
