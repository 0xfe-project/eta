/**
 * Write `SHA256SUMS` beside an asset in each directory of a builds directory, the way publishing
 * does for a release.
 *
 *   bun scripts/upgrade-e2e/sums.ts <builds> <asset>
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const [builds, asset] = process.argv.slice(2);
if (builds === undefined || asset === undefined)
  throw new Error("usage: sums.ts <builds> <asset>");

for (const version of readdirSync(builds)) {
  const dir = join(builds, version);
  const sha256 = new Bun.CryptoHasher("sha256")
    .update(readFileSync(join(dir, asset)))
    .digest("hex");
  writeFileSync(join(dir, "SHA256SUMS"), `${sha256}  ${asset}\n`);
}
