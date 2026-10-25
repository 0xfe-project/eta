/** Build the c-shared library where `libraryPath()` will load it. */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { libraryPath } from "../src/index";
import { toolEnvironment } from "./toolchain";

const root = join(import.meta.dirname, "..");
const output = libraryPath();
await mkdir(dirname(output), { recursive: true });

const child = Bun.spawn(
  ["go", "build", "-buildmode=c-shared", "-o", output, "./ffi"],
  {
    cwd: root,
    env: toolEnvironment(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exitCode = await child.exited;
