/**
 * The generated table, and what it comes to in a real `bun build --compile` executable: hashed
 * names resolved through the table, files that can be read, and an unpack that holds with several
 * processes on one data directory.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import {
  digestOf,
  embeddedModule,
  filesIn,
  writeEmbedded,
} from "../scripts/embed";
import { tempDir } from "./support/host";

const RESOURCES = resolve(import.meta.dirname, "../src/resources.ts");

/** A tree with a page, a stray `.env` and one in a dot directory. */
async function web(): Promise<string> {
  const dir = await tempDir("eta-web-");
  mkdirSync(join(dir, "assets"));
  mkdirSync(join(dir, ".cache"));
  writeFileSync(join(dir, "index.html"), "<title>eta</title>");
  writeFileSync(join(dir, "BUILD"), "b1");
  writeFileSync(join(dir, "assets", "app-abc.js"), "console.log(1)");
  writeFileSync(join(dir, ".env"), "SECRET=1");
  writeFileSync(join(dir, ".cache", "token"), "SECRET=2");
  return dir;
}

describe("the generated table", () => {
  it("names every file by its path in the tree, and leaves dotfiles out", async () => {
    const dir = await web();
    const names = filesIn(dir, "web").map(({ name }) => name);
    expect(names.sort()).toEqual([
      "web/BUILD",
      "web/assets/app-abc.js",
      "web/index.html",
    ]);
  });

  it("imports each file as a file and maps the original name to it", async () => {
    const text = embeddedModule(
      [
        { name: "web/index.html", path: "/repo/web/index.html" },
        { name: "Eta-Logo.png", path: "/repo/Eta-Logo.png" },
      ],
      { cpa: "abcd" },
      "/repo/resources.ts",
    );
    expect(text).toContain(
      'import file0 from "/repo/Eta-Logo.png" with { type: "file" };',
    );
    expect(text).toContain(
      'import file1 from "/repo/web/index.html" with { type: "file" };',
    );
    expect(text).toContain('"Eta-Logo.png": file0,');
    expect(text).toContain('"web/index.html": file1,');
    expect(text).toContain('digests: {"cpa":"abcd"}');
    expect(text).toContain('from "/repo/resources.ts"');
  });

  it("gives a digest that follows the content and not the order", async () => {
    const dir = await tempDir();
    writeFileSync(join(dir, "a"), "one");
    writeFileSync(join(dir, "b"), "two");
    const a = { name: "x/a", path: join(dir, "a") };
    const b = { name: "x/b", path: join(dir, "b") };
    const digest = digestOf([a, b]);
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    expect(digestOf([b, a])).toBe(digest);
    writeFileSync(join(dir, "b"), "three");
    expect(digestOf([a, b])).not.toBe(digest);
  });

  it("compresses the daemons and keeps the manifest as it was", async () => {
    const out = join(await tempDir(), "embed");
    const daemons = await tempDir("eta-builds-");
    const build = "daemon ".repeat(1000);
    writeFileSync(join(daemons, "eta-daemon-linux-x64"), build);
    const manifest = JSON.stringify({
      version: "v1",
      builds: {
        "linux-x64": {
          file: "eta-daemon-linux-x64",
          sha256: createHash("sha256").update(build).digest("hex"),
          size: build.length,
        },
      },
    });
    writeFileSync(join(daemons, "manifest.json"), manifest);
    const cpa = join(await tempDir(), "cli-proxy-api");
    writeFileSync(cpa, "cpa");

    const entry = await writeEmbedded({
      out,
      web: await web(),
      daemons,
      cpa: [cpa],
    });

    const text = readFileSync(join(out, "embedded.ts"), "utf8");
    expect(text).toContain('"migrations/0001-agents.sql"');
    expect(text).toContain('"Eta-Logo.png"');
    expect(text).toContain('"web/index.html"');
    expect(text).toContain('"cpa/cli-proxy-api"');
    expect(text).toContain('"daemon/eta-daemon-linux-x64.zst"');
    expect(text).not.toContain('"daemon/eta-daemon-linux-x64"');
    expect(text).not.toContain("/.env");
    expect(text).not.toContain("/.cache/token");
    expect(readFileSync(join(out, "daemon", "manifest.json"), "utf8")).toBe(
      manifest,
    );
    const packed = readFileSync(
      join(out, "daemon", "eta-daemon-linux-x64.zst"),
    );
    expect(packed.length).toBeLessThan(build.length);
    expect(Bun.zstdDecompressSync(packed).toString()).toBe(build);

    // The table before the host: this order is what makes it visible to the host's modules.
    const lines = readFileSync(entry, "utf8").split("\n");
    expect(lines[1]).toContain("embedded.ts");
    expect(lines[2]).toContain("src/main.ts");
  });
});

describe("a compiled executable", () => {
  /**
   * Compile a program that reports what `resources.ts` says from inside the executable. It unpacks
   * `tool/run` and a compressed build when given a data directory.
   */
  async function compiled(): Promise<string> {
    const dir = await tempDir("eta-compile-");
    const page = await web();
    const tool = join(dir, "run");
    writeFileSync(tool, "#!/bin/sh\necho ran\n");
    const big = "daemon build\n".repeat(200_000);
    const packed = join(dir, "build.zst");
    writeFileSync(packed, Bun.zstdCompressSync(Buffer.from(big)));
    const files = [
      ...filesIn(page, "web"),
      { name: "tool/run", path: tool },
      { name: "tool/build.zst", path: packed },
    ];
    writeFileSync(
      join(dir, "embedded.ts"),
      embeddedModule(files, { tool: "cafe" }, RESOURCES),
    );
    const expected = {
      size: big.length,
      sha256: createHash("sha256").update(big).digest("hex"),
    };
    writeFileSync(
      join(dir, "entry.ts"),
      `import "./embedded.ts";
import { readFileSync } from "node:fs";
import { embeddedFiles, resource, resourceNames, unpack } from ${JSON.stringify(RESOURCES)};
const dataDir = process.argv[2];
const expected = ${JSON.stringify(expected)};
console.log(JSON.stringify({
  names: resourceNames("web"),
  index: resource("web/index.html"),
  read: readFileSync(resource("web/index.html"), "utf8"),
  file: await Bun.file(resource("web/BUILD")).text(),
  web: Object.keys(embeddedFiles("web") ?? {}),
  run: dataDir === undefined ? undefined : await unpack(dataDir, "tool/run"),
  build: dataDir === undefined ? undefined : await unpack(dataDir, "tool/build.zst", expected),
}));
`,
    );
    const outfile = join(dir, "program");
    const build = Bun.spawnSync(
      [
        process.execPath,
        "build",
        "--compile",
        "--target=bun",
        join(dir, "entry.ts"),
        "--outfile",
        outfile,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(build.stderr.toString()).toBe("");
    expect(build.exitCode).toBe(0);
    return outfile;
  }

  it("finds its files by their original names, and they read back", async () => {
    const program = await compiled();
    // Run from another directory, with nothing beside it to find.
    const run = Bun.spawnSync([program], { cwd: await tempDir() });
    const report = JSON.parse(run.stdout.toString()) as {
      names: string[];
      index: string;
      read: string;
      file: string;
      web: string[];
    };
    expect(report.names).toEqual([
      "web/BUILD",
      "web/assets/app-abc.js",
      "web/index.html",
    ]);
    expect(report.index).toMatch(/^\/\$bunfs\/root\/index-[^/]+\.html$/);
    expect(report.read).toBe("<title>eta</title>");
    expect(report.file).toBe("b1");
    expect(report.web).toEqual(["BUILD", "assets/app-abc.js", "index.html"]);
  }, 60_000);

  it("unpacks whole files with several processes starting at once", async () => {
    const program = await compiled();
    const dataDir = await tempDir("eta-data-");
    const runs = Array.from({ length: 6 }, () =>
      Bun.spawn([program, dataDir], { stdout: "pipe", stderr: "pipe" }),
    );
    const reports = await Promise.all(
      runs.map(async (run) => {
        const [stdout, stderr, code] = await Promise.all([
          new Response(run.stdout).text(),
          new Response(run.stderr).text(),
          run.exited,
        ]);
        expect(stderr).toBe("");
        expect(code).toBe(0);
        return JSON.parse(stdout) as { run: string; build: string };
      }),
    );
    const dir = join(dataDir, "unpacked", "tool-cafe");
    for (const report of reports) {
      expect(report.run).toBe(join(dir, "run"));
      expect(report.build).toBe(join(dir, "build"));
    }
    expect(readdirSync(dir).sort()).toEqual(["build", "run"]);
    expect(statSync(join(dir, "run")).mode & 0o777).toBe(0o755);
    expect(Bun.spawnSync([join(dir, "run")]).stdout.toString()).toBe("ran\n");
  }, 60_000);
});
