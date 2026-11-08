/**
 * Writes the machine's platform and architecture where `//#test:install` hashes them (turbo.json):
 * which of the install scripts' tests run depends on the machine (PowerShell only on Windows,
 * dash and mawk on Linux), so a result from one kind of machine must not stand in for another's.
 * This is how turbo's guide to handling platforms does it; the file is under node_modules, which
 * git ignores.
 *
 *   bun scripts/install/platform-key.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

const file = join(
  import.meta.dir,
  "..",
  "..",
  "node_modules",
  ".cache",
  "eta-install-platform.json",
);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(
  file,
  `${JSON.stringify({ platform: process.platform, arch: process.arch })}\n`,
);
