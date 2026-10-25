/** Go checks that work the same under cmd.exe, sh, and Bun's package runner. */
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import process from "node:process";
import { toolEnvironment } from "./toolchain";

const root = join(import.meta.dirname, "..");
const env = toolEnvironment();
const shared = {
  cwd: root,
  env,
  stdin: "inherit" as const,
  stdout: "inherit" as const,
  stderr: "inherit" as const,
};

const vet = Bun.spawn(["go", "vet", "./..."], shared);
if ((await vet.exited) !== 0) process.exit(1);

const goFiles = (
  await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })
).filter((entry) => entry.isFile() && entry.name.endsWith(".go"));
const normalized = (text: string) => text.replaceAll("\r\n", "\n");
const unformatted: string[] = [];

for (const entry of goFiles) {
  const path = join(entry.parentPath, entry.name);
  const source = await readFile(path, "utf8");
  const formatted = spawnSync("gofmt", {
    env,
    input: source,
    encoding: "utf8",
  });
  if (formatted.status !== 0) {
    console.error(formatted.stderr);
    process.exit(formatted.status ?? 1);
  }
  if (normalized(source) !== normalized(formatted.stdout))
    unformatted.push(relative(root, path));
}

if (unformatted.length > 0) {
  console.error(`gofmt needs to format:\n${unformatted.join("\n")}`);
  process.exit(1);
}
