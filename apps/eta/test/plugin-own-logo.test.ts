/**
 * A plugin's own logo: the loader keeps the path from either foreign manifest, and the host reads
 * the file only if it stays inside the plugin and is a safe picture. Local temp dirs only.
 */
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugin } from "@eta/daemon";
import { afterEach, describe, expect, it } from "vitest";
import { readOwnLogo } from "../src/plugins/logo";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eta-logo-"));
  dirs.push(dir);
  return dir;
}
async function put(
  root: string,
  path: string,
  content: string | Buffer,
): Promise<void> {
  const file = join(root, path);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, content);
}

describe("the loader keeps a foreign manifest's logo and homepage", () => {
  it.each([".cursor-plugin", ".claude-plugin"])(
    "from %s/plugin.json",
    async (layout) => {
      const root = await temp();
      await put(
        root,
        `${layout}/plugin.json`,
        JSON.stringify({
          name: "demo",
          logo: "assets/logo.svg",
          homepage: "https://neon.tech/docs",
        }),
      );
      await put(root, "assets/logo.svg", SVG);
      const loaded = await loadPlugin(root);
      expect(loaded.manifest.logo).toBe("assets/logo.svg");
      expect(loaded.manifest.homepage).toBe("https://neon.tech/docs");
      expect(loaded.reports.join("\n")).not.toMatch(/logo/);
    },
  );
});

describe("reading a plugin's own logo", () => {
  it("reads svg and png inside the plugin, with a fixed type", async () => {
    const root = await temp();
    await put(root, "assets/logo.svg", SVG);
    await put(root, "assets/logo.png", PNG);
    expect((await readOwnLogo(root, "assets/logo.svg"))?.type).toBe(
      "image/svg+xml",
    );
    expect(await readOwnLogo(root, "./assets/logo.png")).toEqual({
      type: "image/png",
      data: PNG.toString("base64"),
    });
  });

  it("refuses .. and absolute paths", async () => {
    const root = await temp();
    const outside = await temp();
    await put(outside, "secret.png", PNG);
    await put(root, "ok.png", PNG);
    expect(
      await readOwnLogo(
        join(root, "ok.png", ".."),
        `../${join(outside, "secret.png").split(/[\\/]/).slice(-2).join("/")}`,
      ),
    ).toBeNull();
    expect(await readOwnLogo(root, "../secret.png")).toBeNull();
    expect(await readOwnLogo(root, join(outside, "secret.png"))).toBeNull();
  });

  it("refuses a link that leaves the plugin", async () => {
    const root = await temp();
    const outside = await temp();
    await put(outside, "secret.png", PNG);
    // A junction needs no privilege on Windows; on other systems it is a plain directory link.
    await symlink(outside, join(root, "assets"), "junction");
    expect(await readOwnLogo(root, "assets/secret.png")).toBeNull();
  });

  it("refuses a file link that leaves the plugin, where the system allows one", async () => {
    const root = await temp();
    const outside = await temp();
    await put(outside, "secret.png", PNG);
    try {
      await symlink(
        join(outside, "secret.png"),
        join(root, "logo.png"),
        "file",
      );
    } catch {
      return; // no right to make a file link here
    }
    expect(await readOwnLogo(root, "logo.png")).toBeNull();
  });

  it("refuses a file over the size cap, a wrong extension, and a name that lies", async () => {
    const root = await temp();
    await put(root, "big.png", Buffer.concat([PNG, Buffer.alloc(300 * 1024)]));
    await put(root, "logo.gif", Buffer.from("GIF89a"));
    await put(root, "fake.png", "<html>not a picture</html>");
    expect(await readOwnLogo(root, "big.png")).toBeNull();
    expect(await readOwnLogo(root, "logo.gif")).toBeNull();
    expect(await readOwnLogo(root, "fake.png")).toBeNull();
    expect(await readOwnLogo(root, "missing.png")).toBeNull();
  });

  it("refuses an svg that carries script or leaves the file", async () => {
    const root = await temp();
    await put(
      root,
      "a.svg",
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    await put(
      root,
      "b.svg",
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
    );
    await put(
      root,
      "c.svg",
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="http://evil.example/x.png"/></svg>',
    );
    await put(root, "d.svg", "<div>not svg</div>");
    for (const name of ["a", "b", "c", "d"])
      expect(await readOwnLogo(root, `${name}.svg`)).toBeNull();
  });
});
