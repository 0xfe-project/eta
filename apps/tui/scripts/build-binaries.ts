/**
 * Build `eta` for every platform it ships on:
 *
 *   out/eta-linux-x64   out/eta-darwin-arm64   out/eta-windows-x64.exe
 *
 * Each carries its version (`define ETA_TUI_VERSION`, what `eta --version` prints): `ETA_TUI_VERSION`,
 * else `ETA_DAEMON_VERSION`, which the release workflow sets from the tag for every build, else
 * `dev`. The release workflow picks the files up by these names.
 */
import type { BunPlugin } from "bun";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { buildVersion } from "./build-version";

const TARGETS = [
  { target: "bun-linux-x64", file: "eta-linux-x64" },
  { target: "bun-darwin-arm64", file: "eta-darwin-arm64" },
  { target: "bun-windows-x64", file: "eta-windows-x64.exe" },
] as const;

// Ink imports the React DevTools bridge only when DEV=true, and the bridge is an optional peer
// that is not installed. `--external` leaves an import the compiled program fails on at start,
// so the bridge resolves to an empty module instead.
const withoutDevtools: BunPlugin = {
  name: "without-react-devtools",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, (args) => ({
      path: args.path,
      namespace: "without-react-devtools",
    }));
    build.onLoad({ filter: /.*/, namespace: "without-react-devtools" }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
};

const root = resolve(import.meta.dir, "..");
const out = join(root, "out");
const version = buildVersion(process.env);

mkdirSync(out, { recursive: true });
for (const { target, file } of TARGETS) {
  const result = await Bun.build({
    entrypoints: [join(root, "src", "main.tsx")],
    compile: { target, outfile: join(out, file) },
    define: { ETA_TUI_VERSION: JSON.stringify(version) },
    plugins: [withoutDevtools],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}
console.log(`eta ${version}: ${TARGETS.map((t) => t.file).join(", ")}`);
