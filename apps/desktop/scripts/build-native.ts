#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

if (process.platform === "darwin") {
  const root = dirname(import.meta.dirname);
  const directory = join(root, ".hutch", "native");
  await mkdir(directory, { recursive: true });
  const compiler = [
    "xcrun",
    "--sdk",
    "macosx",
    "clang++",
    "-std=c++17",
    "-fobjc-arc",
    "-fblocks",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-mmacosx-version-min=11.0",
    "-framework",
    "AppKit",
    "-framework",
    "WebKit",
    "-I",
    join(root, "src", "bun", "platform", "mac"),
    join(root, "src", "bun", "platform", "mac", "toolbar-drag.mm"),
  ];
  const run = (command: string[]) => {
    const result = Bun.spawnSync(command, {
      stdout: "inherit",
      stderr: "inherit",
    });
    if (result.exitCode !== 0) process.exit(result.exitCode);
  };
  run([
    ...compiler,
    "-dynamiclib",
    "-arch",
    "arm64",
    "-arch",
    "x86_64",
    "-o",
    join(directory, "libToolbarDrag.dylib"),
  ]);
  if (process.argv.includes("--test")) {
    const executable = join(directory, "toolbar-drag-native-test");
    run([
      ...compiler,
      "-DETA_TOOLBAR_DRAG_TESTING",
      join(root, "test", "toolbar-drag-native.mm"),
      "-o",
      executable,
    ]);
    run([executable]);
  }
}
