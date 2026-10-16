/**
 * The ZIP reader, writer and site check (REFACTOR.md §9, P3.2).
 *
 * The format is small enough to own, and owning it means the rules can be checked where they are
 * decided: what counts as a site, what is refused, and what a package written here looks like when
 * read back. The reader and writer are tested against each other (round trip) and against a ZIP
 * made elsewhere (`zip` on the command line, when the machine has one), because a format that only
 * agrees with itself is a format nobody else can read.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  contentTypeOf,
  DEFAULT_LIMITS,
  InvalidArtifact,
  readSite,
  readZip,
  writeZip,
} from "../src/artifacts/zip";

const site = (files: Record<string, string>) =>
  Object.entries(files).map(([name, text]) => ({
    name,
    bytes: new TextEncoder().encode(text),
  }));

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("writing and reading a ZIP", () => {
  it("round-trips a site, and a reader sees the files it wrote", () => {
    const zip = writeZip(
      site({
        "index.html": "<h1>hi</h1>",
        "assets/app.js": "console.log('hello, world')",
        "assets/style.css": "body { color: red }",
      }),
    );
    const files = readSite(zip);
    expect(files.map((file) => file.name)).toEqual([
      "index.html",
      "assets/app.js",
      "assets/style.css",
    ]);
    const read = Object.fromEntries(
      files.map((file) => [file.name, new TextDecoder().decode(file.bytes)]),
    );
    expect(read["index.html"]).toBe("<h1>hi</h1>");
    expect(read["assets/app.js"]).toBe("console.log('hello, world')");
  });

  it("reads what another tool wrote", async () => {
    // Built by the `zip` command (stored and deflated entries, real central directory), then read
    // here: the point is to agree with the format, not with ourselves. Skipped where the machine
    // has no `zip`; the round trip above still covers the reader.
    const zipPath = ["/usr/bin/zip", "/bin/zip"].find((path) =>
      existsSync(path),
    );
    if (zipPath === undefined) return;
    const site = await mkdtemp(join(tmpdir(), "eta-zip-"));
    try {
      await writeFile(
        join(site, "index.html"),
        "<h1>from the zip command</h1>",
        "utf8",
      );
      await writeFile(join(site, "style.css"), "body { color: blue }", "utf8");
      const made = Bun.spawnSync([zipPath, "-q", "-r", "-", "."], {
        cwd: site,
      });
      expect(made.exitCode).toBe(0);
      const files = readSite(new Uint8Array(made.stdout));
      expect(files.map((file) => file.name).sort()).toEqual([
        "index.html",
        "style.css",
      ]);
      const index = files.find((file) => file.name === "index.html");
      expect(new TextDecoder().decode(index?.bytes)).toContain(
        "from the zip command",
      );
    } finally {
      await rm(site, { recursive: true, force: true });
    }
  });

  it("refuses a package that is not a site, and says what to fix", () => {
    const cases: [Record<string, string>, string][] = [
      // No index.html anywhere: the plain refusal.
      [{ "page.html": "<h1>hi</h1>" }, "根目录没有 index.html"],
      // One inside a single directory: the refusal that says how to repack.
      [{ "assets/index.html": "<h1>hi</h1>" }, "必须在 ZIP 的根目录"],
      [{ "index.html": "x", "../evil.html": "y" }, "相对路径"],
      [{ "index.html": "x", "/etc/passwd": "y" }, "相对路径"],
      [{ "index.html": "x", "a:b.html": "y" }, "反斜杠、冒号或空字符"],
      [{ "index.html": "x", "a\\b.html": "y" }, "反斜杠、冒号或空字符"],
    ];
    for (const [files, expected] of cases) {
      expect(
        () => readSite(writeZip(site(files))),
        JSON.stringify(files),
      ).toThrow(expected);
    }
  });

  it("names the fix when the site is inside a directory", () => {
    const zip = writeZip(site({ "site/index.html": "<h1>hi</h1>" }));
    expect(() => readSite(zip)).toThrow(/cd site && zip -r \.\.\/site\.zip \./);
  });

  it("holds the limits it says it holds", () => {
    const zip = writeZip(site({ "index.html": "hello" }));
    expect(() => readSite(zip, { ...DEFAULT_LIMITS, files: 0 })).toThrow(
      "文件超过 0 个",
    );
    expect(() => readSite(zip, { ...DEFAULT_LIMITS, bytes: 2 })).toThrow(
      "解压后超过 0 MiB",
    );
  });

  it("refuses something that is not a ZIP at all", () => {
    expect(() => readZip(bytesOf("definitely not a zip"))).toThrow(
      InvalidArtifact,
    );
    expect(() => readZip(bytesOf("definitely not a zip"))).toThrow(
      "不是一个 ZIP 文件",
    );
  });
});

describe("what a file is served as", () => {
  it("knows the types a static site needs, and says octet-stream otherwise", () => {
    expect(contentTypeOf("index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeOf("a/b/app.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeOf("style.CSS")).toBe("text/css; charset=utf-8");
    expect(contentTypeOf("font.woff2")).toBe("font/woff2");
    expect(contentTypeOf("data.unknownext")).toBe("application/octet-stream");
  });
});
