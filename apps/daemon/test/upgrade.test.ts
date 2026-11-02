/**
 * A daemon replacing itself: what it checks before the swap, the swap, and settling it after the
 * restart (kept, or put back).
 *
 * The "executables" here are shell scripts that print a version, which is all the trial run asks
 * of a build.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  daemonPlatform,
  installKind,
  settleUpgrade,
  upgrade,
} from "../src/upgrade";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

const script = (version: string): string => `#!/bin/sh\necho ${version}\n`;

async function setting(): Promise<{
  dir: string;
  exe: string;
  dataDir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "eta-upgrade-"));
  dirs.push(dir);
  const exe = join(dir, "eta-daemon");
  await writeFile(exe, script("v1"), { mode: 0o755 });
  return { dir, exe, dataDir: dir };
}

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const identity = {
  url: "http://primary.example:8787",
  machineId: "m1",
  secret: "s3cret",
};

/** A primary that hands out `body` and remembers what it was asked. */
function primary(body: string, status = 200) {
  const asked: { url: string; authorization: string | null }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    asked.push({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return new Response(body, { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked };
}

describe("how the daemon was started", () => {
  it("is a service when a service manager started it, else a binary; bun is source", () => {
    expect(installKind({ INVOCATION_ID: "x" }, "/opt/eta-daemon")).toBe(
      "service",
    );
    expect(
      installKind({ XPC_SERVICE_NAME: "io.eta.daemon" }, "/opt/eta-daemon"),
    ).toBe("service");
    expect(installKind({}, "/opt/eta-daemon")).toBe("binary");
    expect(installKind({ INVOCATION_ID: "x" }, "/usr/bin/bun")).toBe("source");
  });
});

describe("upgrade", () => {
  it("fetches the build with its credential, tries it, and swaps it in keeping the old one", async () => {
    const { exe, dataDir } = await setting();
    const { fetch, asked } = primary(script("v2"));
    const done = await upgrade(
      { version: "v2", sha256: sha256(script("v2")) },
      {
        identity,
        dataDir,
        version: "v1",
        execPath: exe,
        install: "service",
        fetch,
      },
    );
    expect(done).toEqual({ ok: true });
    expect(asked).toEqual([
      {
        url: `http://primary.example:8787/machines/daemon/${daemonPlatform()}`,
        authorization: "Bearer m1.s3cret",
      },
    ]);
    expect(await readFile(exe, "utf8")).toBe(script("v2"));
    expect(await readFile(`${exe}.prev`, "utf8")).toBe(script("v1"));
    expect(existsSync(join(dataDir, "upgrade.json"))).toBe(true);
  });

  it("refuses bytes that are not the build asked for, and touches nothing", async () => {
    const { exe, dataDir } = await setting();
    const { fetch } = primary(script("v2"));
    const done = await upgrade(
      { version: "v2", sha256: "0".repeat(64) },
      {
        identity,
        dataDir,
        version: "v1",
        execPath: exe,
        install: "service",
        fetch,
      },
    );
    expect(done).toMatchObject({ ok: false, reason: /not the one asked for/ });
    expect(await readFile(exe, "utf8")).toBe(script("v1"));
    expect(existsSync(`${exe}.next`)).toBe(false);
  });

  it("refuses a build that says it is another version", async () => {
    const { exe, dataDir } = await setting();
    const { fetch } = primary(script("v3"));
    const done = await upgrade(
      { version: "v2", sha256: sha256(script("v3")) },
      {
        identity,
        dataDir,
        version: "v1",
        execPath: exe,
        install: "service",
        fetch,
      },
    );
    expect(done).toMatchObject({ ok: false, reason: /says it is v3/ });
    expect(await readFile(exe, "utf8")).toBe(script("v1"));
    expect(existsSync(join(dataDir, "upgrade.json"))).toBe(false);
  });

  it("will not replace a daemon nothing would start again", async () => {
    const { exe, dataDir } = await setting();
    const { fetch, asked } = primary(script("v2"));
    for (const install of ["binary", "source"] as const) {
      const done = await upgrade(
        { version: "v2", sha256: sha256(script("v2")) },
        { identity, dataDir, version: "v1", execPath: exe, install, fetch },
      );
      expect(done.ok).toBe(false);
    }
    expect(asked).toHaveLength(0);
  });
});

describe("settling an upgrade after the restart", () => {
  async function upgraded() {
    const s = await setting();
    const { fetch } = primary(script("v2"));
    await upgrade(
      { version: "v2", sha256: sha256(script("v2")) },
      {
        identity,
        dataDir: s.dataDir,
        version: "v1",
        execPath: s.exe,
        install: "service",
        fetch,
      },
    );
    return s;
  }

  it("a new build that gets back in keeps its place, and the old file goes", async () => {
    const { exe, dataDir } = await upgraded();
    const rolled: string[] = [];
    const settled = settleUpgrade({
      dataDir,
      version: "v2",
      execPath: exe,
      rollBack: (reason) => rolled.push(reason),
    });
    settled.admitted();
    expect(rolled).toEqual([]);
    expect(existsSync(join(dataDir, "upgrade.json"))).toBe(false);
    expect(existsSync(`${exe}.prev`)).toBe(false);
    expect(await readFile(exe, "utf8")).toBe(script("v2"));
  });

  it("one that does not get back in in time puts the old one back", async () => {
    const { exe, dataDir } = await upgraded();
    const rolled: string[] = [];
    settleUpgrade({
      dataDir,
      version: "v2",
      execPath: exe,
      settleMs: 10,
      rollBack: (reason) => rolled.push(reason),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rolled).toEqual(["did not get back in"]);
    expect(await readFile(exe, "utf8")).toBe(script("v1"));
    expect(existsSync(join(dataDir, "upgrade.json"))).toBe(false);
  });

  it("one started again and again without getting in is put back at once", async () => {
    const { exe, dataDir } = await upgraded();
    const marker = JSON.parse(
      await readFile(join(dataDir, "upgrade.json"), "utf8"),
    );
    await writeFile(
      join(dataDir, "upgrade.json"),
      JSON.stringify({ ...marker, starts: 3 }),
    );
    const rolled: string[] = [];
    settleUpgrade({
      dataDir,
      version: "v2",
      execPath: exe,
      rollBack: (r) => rolled.push(r),
    });
    expect(rolled).toHaveLength(1);
    expect(await readFile(exe, "utf8")).toBe(script("v1"));
  });

  it("the old build, back after a roll-back, just clears the marker", async () => {
    const { exe, dataDir } = await upgraded();
    const rolled: string[] = [];
    settleUpgrade({
      dataDir,
      version: "v1",
      execPath: exe,
      rollBack: (r) => rolled.push(r),
    });
    expect(rolled).toEqual([]);
    expect(existsSync(join(dataDir, "upgrade.json"))).toBe(false);
  });
});
