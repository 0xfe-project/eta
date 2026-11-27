/**
 * scripts/format.ts [--check] [paths...]
 *
 * Format the repository with oxfmt, downloading the release binary on first use. The dprint check
 * that used to guard formatting is gone with the rest of the Node-only tooling, so '--check' is
 * how a machine decides formatting is clean.
 */
import process from "node:process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "./oxc.ts";

/** The repository's config for this tool, named explicitly when it exists: a path outside the
 *  repository has no config file above it, and the same rules should apply wherever it is pointed. */
function configPath(name: string): string[] {
  const path = fileURLToPath(new URL("../" + name, import.meta.url));
  return existsSync(path) ? ["--config", path] : [];
}

const argv = process.argv.slice(2);
const config = configPath(".oxfmtrc.json");
process.exit(await run("oxfmt", [...config, ...(argv.length > 0 ? argv : ["."])]));
