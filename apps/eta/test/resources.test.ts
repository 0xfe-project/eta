/**
 * The host's own files, from the checkout and from a table: `resource()` in both modes, unpacking
 * to `<dataDir>/unpacked`, and the daemon builds a compiled host carries. A table's paths are
 * plain files here; `embed.test.ts` compiles a real executable.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildsIn, defaultBuilds } from "../src/machines/builds";
import {
  embeddedFiles,
  embedResources,
  resource,
  resourceNames,
  unpack,
} from "../src/resources";
import { tempDir } from "./support/host";

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const mode = (path: string): number => statSync(path).mode & 0o777;

afterEach(() => {
  embedResources(undefined);
});

describe("resource", () => {
  it("is the checkout's file when run from source", () => {
    const name = "migrations/0001-agents.sql";
    expect(resourceNames("migrations")).toContain(name);
    expect(readFileSync(resource(name), "utf8")).toContain("CREATE TABLE");
    expect(resource("Eta-Logo.png")).toMatch(
      /apps\/web\/public\/Eta-Logo\.png$/,
    );
    expect(statSync(resource("Eta-Logo.png")).size).toBeGreaterThan(0);
    expect(() => resource("nothing.txt")).toThrow(/no resource/);
  });

  it("carries no page and no daemons when run from source", () => {
    expect(embeddedFiles("web")).toBeUndefined();
    expect(embeddedFiles("daemon")).toBeUndefined();
    expect(embeddedFiles("cpa")).toBeUndefined();
  });

  it("is the table's path when embedded, by the original name", () => {
    embedResources({
      files: {
        "Eta-Logo.png": "/$bunfs/root/Eta-Logo-1234.png",
        "migrations/0002-b.sql": "/$bunfs/root/0002-b-5678.sql",
        "migrations/0001-a.sql": "/$bunfs/root/0001-a-9abc.sql",
        "web/assets/app.js": "/$bunfs/root/app-def0.js",
      },
      digests: {},
    });
    expect(resource("Eta-Logo.png")).toBe("/$bunfs/root/Eta-Logo-1234.png");
    expect(resourceNames("migrations")).toEqual([
      "migrations/0001-a.sql",
      "migrations/0002-b.sql",
    ]);
    expect(embeddedFiles("web")).toEqual({
      "assets/app.js": "/$bunfs/root/app-def0.js",
    });
    expect(() => resource("migrations/0003-c.sql")).toThrow(/no resource/);
  });
});

describe("unpack", () => {
  /** A table with one executable in `tool/`, at `digest`. */
  async function tool(body = "#!/bin/sh\necho ok\n", digest = "aaaa") {
    const dir = await tempDir("eta-carried-");
    const dataDir = await tempDir("eta-data-");
    writeFileSync(join(dir, "run-1234"), body);
    embedResources({
      files: { "tool/run": join(dir, "run-1234") },
      digests: { tool: digest },
    });
    return {
      dataDir,
      target: join(dataDir, "unpacked", `tool-${digest}`, "run"),
    };
  }

  it("writes an executable to a directory named after the content", async () => {
    const { dataDir, target } = await tool();
    expect(await unpack(dataDir, "tool/run")).toBe(target);
    expect(readFileSync(target, "utf8")).toContain("echo ok");
    expect(mode(target)).toBe(0o755);
    expect(mode(join(target, ".."))).toBe(0o755);
    expect(Bun.spawnSync([target]).stdout.toString()).toBe("ok\n");
  });

  it("leaves a file that is already there alone", async () => {
    const { dataDir, target } = await tool();
    await unpack(dataDir, "tool/run");
    const before = statSync(target).mtimeMs;
    await Bun.sleep(5);
    await unpack(dataDir, "tool/run");
    expect(statSync(target).mtimeMs).toBe(before);
  });

  it("writes it once for callers at the same time, and leaves no part behind", async () => {
    const { dataDir, target } = await tool();
    const paths = await Promise.all(
      Array.from({ length: 8 }, () => unpack(dataDir, "tool/run")),
    );
    expect(new Set(paths)).toEqual(new Set([target]));
    expect(readdirSync(join(target, ".."))).toEqual(["run"]);
  });

  it("comes back after the directory is deleted", async () => {
    const { dataDir, target } = await tool();
    await unpack(dataDir, "tool/run");
    await rm(join(dataDir, "unpacked"), { recursive: true });
    expect(await unpack(dataDir, "tool/run")).toBe(target);
    expect(existsSync(target)).toBe(true);
  });

  it("replaces a file cut short", async () => {
    const { dataDir, target } = await tool();
    await unpack(dataDir, "tool/run");
    writeFileSync(target, "#!");
    await unpack(dataDir, "tool/run");
    expect(readFileSync(target, "utf8")).toContain("echo ok");
  });

  it("removes other versions of the same directory, and only those", async () => {
    const { dataDir, target } = await tool();
    const root = join(dataDir, "unpacked");
    for (const old of ["tool-bbbb", "tool-cccc", "other-dddd"]) {
      mkdirSync(join(root, old), { recursive: true });
      writeFileSync(join(root, old, "file"), "old");
    }
    await unpack(dataDir, "tool/run");
    expect(readdirSync(root).sort()).toEqual(["other-dddd", "tool-aaaa"]);
    expect(existsSync(target)).toBe(true);
  });

  it("writes nothing when the content is not what was expected", async () => {
    const { dataDir, target } = await tool();
    await expect(
      unpack(dataDir, "tool/run", { size: 18, sha256: "0".repeat(64) }),
    ).rejects.toThrow(/unpacked to/);
    expect(readdirSync(join(target, ".."))).toEqual([]);
  });
});

describe("the daemon builds a compiled host carries", () => {
  const PLATFORM = "linux-x64";
  const BUILD = `#!/bin/sh\necho v2\n${"# padding\n".repeat(500)}`;

  /** The table a compiled host has: a compressed build and the manifest of the plain one. */
  async function carried(
    manifest = { sha256: sha256(BUILD), size: BUILD.length },
  ) {
    const dir = await tempDir("eta-carried-");
    const dataDir = await tempDir("eta-data-");
    writeFileSync(
      join(dir, "build-1234.zst"),
      Bun.zstdCompressSync(Buffer.from(BUILD)),
    );
    writeFileSync(
      join(dir, "manifest-5678.json"),
      JSON.stringify({
        version: "v2",
        builds: { [PLATFORM]: { file: `eta-daemon-${PLATFORM}`, ...manifest } },
      }),
    );
    embedResources({
      files: {
        "daemon/manifest.json": join(dir, "manifest-5678.json"),
        [`daemon/eta-daemon-${PLATFORM}.zst`]: join(dir, "build-1234.zst"),
      },
      digests: { daemon: "bbbb" },
    });
    return defaultBuilds(dataDir);
  }

  it("says what it carries without unpacking anything", async () => {
    const builds = await carried();
    expect(builds.version()).toBe("v2");
    const build = builds.get(PLATFORM);
    expect(build?.sha256).toBe(sha256(BUILD));
    expect(build?.size).toBe(BUILD.length);
    expect(builds.get("darwin-arm64")).toBeUndefined();
  });

  it("unpacks a build on demand to the bytes the manifest describes", async () => {
    const build = (await carried()).get(PLATFORM);
    const path = await build?.path();
    expect(path).toMatch(/unpacked\/daemon-bbbb\/eta-daemon-linux-x64$/);
    const bytes = readFileSync(path as string);
    expect(sha256(bytes)).toBe(build?.sha256);
    expect(bytes.length).toBe(build?.size);
    expect(mode(path as string)).toBe(0o755);
    expect(readdirSync(join(path as string, ".."))).toEqual([
      "eta-daemon-linux-x64",
    ]);
  });

  it("does not hand out a build the manifest does not describe", async () => {
    const build = (
      await carried({ sha256: "0".repeat(64), size: BUILD.length })
    ).get(PLATFORM);
    await expect(build?.path()).rejects.toThrow(/unpacked to/);
  });
});

describe("the daemon builds in a directory", () => {
  it("are read again when the manifest changes on disk", async () => {
    const dir = await tempDir("eta-builds-");
    const manifest = (version: string) =>
      JSON.stringify({
        version,
        builds: { "linux-x64": { file: "d", sha256: "0", size: 1 } },
      });
    const builds = buildsIn(dir);
    expect(builds.version()).toBeUndefined();

    writeFileSync(join(dir, "manifest.json"), manifest("v1"));
    expect(builds.version()).toBe("v1");
    expect(await builds.get("linux-x64")?.path()).toBe(join(dir, "d"));

    await Bun.sleep(5);
    writeFileSync(join(dir, "manifest.json"), manifest("v2"));
    expect(builds.version()).toBe("v2");

    await rm(join(dir, "manifest.json"));
    expect(builds.version()).toBeUndefined();
  });
});
