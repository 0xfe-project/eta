import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeFileAtomically } from "../../src/config/write-file";
import { tempDir } from "../support/temp";

describe("writeFileAtomically", () => {
  it("replaces the file and leaves only it in the directory", async () => {
    const dir = await tempDir();
    const file = join(dir, "f.json");
    await writeFile(file, "old");
    await writeFileAtomically(file, "new");
    expect(await readFile(file, "utf8")).toBe("new");
    expect(await readdir(dir)).toEqual(["f.json"]);
  });

  it("throws and leaves no temporary file when the final rename fails", async () => {
    // A directory with something in it where the file goes: the temporary file is written,
    // and renaming it over the directory fails on every platform.
    const dir = await tempDir();
    const file = join(dir, "f.json");
    await mkdir(file);
    await writeFile(join(file, "inside"), "");
    await expect(writeFileAtomically(file, "new")).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["f.json"]);
    expect(await readdir(file)).toEqual(["inside"]);
  });
});
