import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findHostProgram } from "../../src/connection/host-program";
import { tempDir } from "../support/temp";

const WIN = process.platform === "win32";
const platform = process.platform;
/** What a program is named on this platform. */
const exe = (name: string) => (WIN ? `${name}.exe` : name);

async function program(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, WIN ? "" : "#!/bin/sh\nexit 0\n");
  if (!WIN) await chmod(path, 0o755);
  return path;
}

/** An environment that names only what the test gives it: never the machine's real PATH. */
function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return { PATHEXT: process.env.PATHEXT ?? ".EXE", PATH: "", ...values };
}

describe("findHostProgram", () => {
  it("uses ETA_HOST_BIN when it names a file, over PATH and the home", async () => {
    const root = await tempDir();
    const pinned = await program(join(root, "pinned"), "my-host");
    const onPath = join(root, "bin");
    await program(onPath, exe("eta-host"));
    const home = join(root, "home");
    await program(join(home, ".eta", "bin"), exe("eta-host"));
    expect(
      findHostProgram({
        env: env({ ETA_HOST_BIN: pinned, PATH: onPath }),
        platform,
        home,
      }),
    ).toEqual({ command: pinned, args: [] });
  });

  it("finds nothing when ETA_HOST_BIN names a missing file, and does not look further", async () => {
    const root = await tempDir();
    const onPath = join(root, "bin");
    await program(onPath, exe("eta-host"));
    const home = join(root, "home");
    await program(join(home, ".eta", "bin"), exe("eta-host"));
    expect(
      findHostProgram({
        env: env({ ETA_HOST_BIN: join(root, "gone"), PATH: onPath }),
        platform,
        home,
      }),
    ).toBeUndefined();
  });

  it("looks on PATH next, when ETA_HOST_BIN is empty or absent", async () => {
    const root = await tempDir();
    const onPath = join(root, "bin");
    const found = await program(onPath, exe("eta-host"));
    const home = join(root, "home");
    await program(join(home, ".eta", "bin"), exe("eta-host"));
    const extras: Record<string, string>[] = [{}, { ETA_HOST_BIN: "" }];
    for (const extra of extras) {
      const result = findHostProgram({
        env: env({ ...extra, PATH: onPath }),
        platform,
        home,
      });
      expect(result?.args).toEqual([]);
      expect(result?.command.toLowerCase()).toBe(found.toLowerCase());
    }
  });

  it("falls back to the program under the home's .eta/bin", async () => {
    const root = await tempDir();
    const home = join(root, "home");
    const found = await program(join(home, ".eta", "bin"), exe("eta-host"));
    expect(
      findHostProgram({
        env: env({ PATH: join(root, "empty") }),
        platform,
        home,
      }),
    ).toEqual({ command: found, args: [] });
  });

  it("finds nothing when the host is nowhere", async () => {
    const root = await tempDir();
    expect(
      findHostProgram({ env: env({}), platform, home: join(root, "home") }),
    ).toBeUndefined();
  });

  it("does not take the Windows name on other platforms, nor the bare name on Windows", async () => {
    const root = await tempDir();
    const home = join(root, "home");
    await program(join(home, ".eta", "bin"), WIN ? "eta-host" : "eta-host.exe");
    expect(findHostProgram({ env: env({}), platform, home })).toBeUndefined();
  });
});
