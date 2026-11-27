/**
 * scripts/lint.ts [--fix] [paths...]
 *
 * Lint the repository with oxlint, downloading the release binary on first use. With no paths the
 * whole repository is linted, which is what 'lint' alone should do.
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
// The config is named rather than found: a path outside the repository has no .oxlintrc.json above
// it, and the same rules should apply wherever the tool is pointed.
const config = configPath(".oxlintrc.json");
process.exit(await run("oxlint", [...config, ...(argv.length > 0 ? argv : ["."])]));
