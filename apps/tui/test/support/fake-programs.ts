/**
 * Small Bun scripts that stand in for `eta-host` where the real one must not run (installing a
 * service) or cannot be made to misbehave on demand (never ready, ignoring the stop request).
 */
import type { HostProgram } from "../../src/connection/types";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { tempDir } from "./temp";

/** Writes `source` to a script in a temp directory and returns how to run it with this Bun. */
export async function script(source: string): Promise<HostProgram> {
  const path = join(await tempDir("eta-tui-fake-"), "fake.ts");
  await writeFile(path, source);
  return { command: process.execPath, args: [path] };
}

/**
 * `install-service` as a script: prints its arguments, then `FAKE_OUT` on stdout and
 * `FAKE_ERR` on stderr, sleeps `FAKE_SLEEP_MS`, and exits with `FAKE_EXIT`.
 */
export function fakeInstaller(): Promise<HostProgram> {
  return script(`
const env = process.env;
console.log("args:" + JSON.stringify(process.argv.slice(2)));
if (env.FAKE_OUT) console.log(env.FAKE_OUT);
if (env.FAKE_ERR) console.error(env.FAKE_ERR);
await new Promise((resolve) => setTimeout(resolve, Number(env.FAKE_SLEEP_MS ?? 0)));
process.exit(Number(env.FAKE_EXIT ?? 0));
`);
}
