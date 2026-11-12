import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureConfigFile, saveConnection } from "../../src/config/save";
import { tempDir } from "../support/temp";

const POSIX = process.platform !== "win32";
const mode = async (path: string) => (await stat(path)).mode & 0o777;

describe("saveConnection", () => {
  it("creates the file and its directories when there is none", async () => {
    const file = join(await tempDir(), "a", "b", "tui.json");
    const result = await saveConnection(file, {
      mode: "resident",
      url: "http://127.0.0.1:8787",
      token: "secret",
    });
    expect(result).toBeUndefined();
    expect(await readFile(file, "utf8")).toBe(
      `${JSON.stringify(
        {
          connection: {
            mode: "resident",
            url: "http://127.0.0.1:8787",
            token: "secret",
          },
        },
        null,
        2,
      )}\n`,
    );
  });

  it("replaces only the connection and keeps every other key in its place", async () => {
    const file = join(await tempDir(), "tui.json");
    await writeFile(
      file,
      '{\n  "$schema": "s",\n  "connection": {"mode": "resident", "url": "http://old:1", "token": "x"},\n  "theme": {"accent": "red"},\n  "zzz": [1, 2]\n}',
    );
    expect(await saveConnection(file, { mode: "temporary" })).toBeUndefined();
    const text = await readFile(file, "utf8");
    expect(text).toBe(
      `${JSON.stringify(
        {
          $schema: "s",
          connection: { mode: "temporary" },
          theme: { accent: "red" },
          zzz: [1, 2],
        },
        null,
        2,
      )}\n`,
    );
  });

  it("reports an IO failure instead of throwing", async () => {
    // A directory standing where the file goes: it can be neither read as JSON nor replaced.
    const dir = await tempDir();
    const file = join(dir, "tui.json");
    await mkdir(file);
    const result = await saveConnection(file, { mode: "temporary" });
    expect(result).toMatchObject({ reason: "io", file });
    expect((result as { detail: string }).detail).toMatch(/\S/);
  });

  it.skipIf(!POSIX)(
    "makes new directories 0700 and the file 0600",
    async () => {
      const root = await tempDir();
      const file = join(root, "eta", "tui.json");
      await saveConnection(file, { mode: "temporary" });
      expect(await mode(join(root, "eta"))).toBe(0o700);
      expect(await mode(file)).toBe(0o600);
    },
  );

  it.skipIf(!POSIX)(
    "makes an existing file 0600 when it rewrites it",
    async () => {
      const file = join(await tempDir(), "tui.json");
      await writeFile(file, "{}");
      await chmod(file, 0o644);
      await saveConnection(file, { mode: "temporary" });
      expect(await mode(file)).toBe(0o600);
    },
  );
});

describe("ensureConfigFile", () => {
  it("creates an empty object when there is no file", async () => {
    const file = join(await tempDir(), "x", "tui.json");
    expect(await ensureConfigFile(file)).toBeUndefined();
    expect(await readFile(file, "utf8")).toBe("{}\n");
  });

  it("leaves an existing file as it is, even one that is not JSON", async () => {
    const file = join(await tempDir(), "tui.json");
    await writeFile(file, "not json");
    expect(await ensureConfigFile(file)).toBeUndefined();
    expect(await readFile(file, "utf8")).toBe("not json");
  });

  it("reports an IO failure instead of throwing", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "blocker"), "");
    const file = join(dir, "blocker", "tui.json");
    expect(await ensureConfigFile(file)).toMatchObject({ reason: "io", file });
  });

  it.skipIf(!POSIX)("creates the file 0600", async () => {
    const file = join(await tempDir(), "tui.json");
    await ensureConfigFile(file);
    expect(await mode(file)).toBe(0o600);
  });
});
