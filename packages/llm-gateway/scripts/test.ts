/** Go and TypeScript tests with the same PATH repair as the build. */
import { join } from "node:path";
import process from "node:process";
import { toolEnvironment } from "./toolchain";

const root = join(import.meta.dirname, "..");
const shared = {
  cwd: root,
  env: toolEnvironment(),
  stdin: "inherit" as const,
  stdout: "inherit" as const,
  stderr: "inherit" as const,
};

const go = Bun.spawn(["go", "test", "./..."], shared);
if ((await go.exited) !== 0) process.exit(1);

const vitest = Bun.spawn(
  [process.execPath, "--bun", "vitest", "--run"],
  shared,
);
process.exitCode = await vitest.exited;
