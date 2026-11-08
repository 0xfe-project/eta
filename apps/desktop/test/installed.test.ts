import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostHome, installHost, runningHost } from "../src/bun/installed";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eta-installed-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the host the app runs", () => {
  it("is a copy of the seed in the user's directory, made once", async () => {
    const seed = join(dir, "bundle", "eta-host");
    await Bun.write(seed, "seed 1");
    const home = hostHome(join(dir, "home"));
    expect(home).toBe(join(dir, "home", ".eta", "desktop", "host"));

    const file = await installHost(seed, home);
    expect(file).toBe(join(home, "eta-host"));
    expect(await readFile(file, "utf8")).toBe("seed 1");
    expect((await stat(file)).mode & 0o111).not.toBe(0);

    // An upgrade replaced it; a newer seed does not put itself back over that.
    await writeFile(file, "upgraded");
    await Bun.write(seed, "seed 2");
    await installHost(seed, home);
    expect(await readFile(file, "utf8")).toBe("upgraded");
  });
});

/** A host's `running` answer, as a script prints it. */
async function answering(output: string, code = 0): Promise<string[]> {
  const script = join(dir, "running.ts");
  await writeFile(
    script,
    `console.log(${JSON.stringify(output)}); process.exit(${String(code)});`,
  );
  return [process.execPath, script];
}

describe("asking for a host already running", () => {
  it("opens what the host names, with the token from its file", async () => {
    const tokenFile = join(dir, "access-token");
    await writeFile(tokenFile, "s3cret-token-of-sixteen\n");
    const found = await runningHost(
      await answering(
        JSON.stringify({
          address: "http://127.0.0.1:8790",
          tokenFile,
          from: "service",
        }),
      ),
      dir,
      process.env,
    );
    expect(found).toEqual({
      address: "http://127.0.0.1:8790",
      token: "s3cret-token-of-sixteen",
    });
  });

  it("finds nothing in null, a failure or a build that does not know the question", async () => {
    expect(
      await runningHost(await answering("null"), dir, process.env),
    ).toBeUndefined();
    expect(
      await runningHost(
        await answering("Usage: eta-host", 2),
        dir,
        process.env,
      ),
    ).toBeUndefined();
    expect(
      await runningHost([join(dir, "missing")], dir, process.env),
    ).toBeUndefined();
    expect(existsSync(join(dir, "missing"))).toBe(false);
  });
});
