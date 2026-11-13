/**
 * Runs the program it is given (the real host from source, in these tests) with its stdout and
 * stderr, and writes that program's pid to `RECORD_PID_FILE`, so a test can end the host the
 * way a crash would. A stop request reaches the host itself: SIGTERM is passed on, and on
 * Windows the host reads the stop pipe named in the environment it inherits.
 */
import { writeFileSync } from "node:fs";
import process from "node:process";

const [command = "", ...args] = process.argv.slice(2);
const child = Bun.spawn([command, ...args], {
  stdio: ["ignore", "inherit", "inherit"],
  env: process.env,
});
writeFileSync(process.env.RECORD_PID_FILE ?? "", String(child.pid));
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => child.kill(signal));
process.exit(await child.exited);
