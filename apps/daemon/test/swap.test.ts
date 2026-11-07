/** Swapping a file where a hard link cannot be made, or the old one cannot be deleted. */
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { swapBack, swapIn, sweepPrevious } from "../src/swap";

/** Names `rm` cannot delete, as Windows cannot delete the file of a running program. */
const running = vi.hoisted(() => new Set<string>());

vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return {
    ...real,
    link: () => Promise.reject(new Error("EPERM")),
    rm: (path: string, options: object) =>
      running.has(path)
        ? Promise.reject(new Error("EBUSY"))
        : real.rm(path, options),
  };
});

const dirs: string[] = [];
afterEach(async () => {
  running.clear();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function setting(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eta-swap-"));
  dirs.push(dir);
  const exe = join(dir, "program");
  await writeFile(exe, "old");
  return exe;
}

describe("swapIn without hard links", () => {
  it("moves the old file aside", async () => {
    const exe = await setting();
    await writeFile(`${exe}.next`, "new");
    await swapIn(exe);
    expect(await readFile(exe, "utf8")).toBe("new");
    expect(await readFile(`${exe}.prev`, "utf8")).toBe("old");
  });

  it("puts it back when the new one cannot take the name", async () => {
    const exe = await setting();
    await expect(swapIn(exe)).rejects.toThrow();
    expect(await readFile(exe, "utf8")).toBe("old");
    expect(existsSync(`${exe}.prev`)).toBe(false);
  });
});

describe("swapIn on Windows", () => {
  it("moves the old file aside, because a running program's cannot be replaced", async () => {
    const exe = await setting();
    await writeFile(`${exe}.next`, "new");
    await swapIn(exe, true);
    expect(await readFile(exe, "utf8")).toBe("new");
    expect(await readFile(`${exe}.prev`, "utf8")).toBe("old");
  });

  it("moves a .prev something still runs out of the way, and it goes once that is over", async () => {
    const exe = await setting();
    await writeFile(`${exe}.prev`, "older");
    await writeFile(`${exe}.next`, "new");
    running.add(`${exe}.prev`);
    await swapIn(exe, true);
    expect(await readFile(`${exe}.prev`, "utf8")).toBe("old");
    const moved = (await readdir(dirname(exe))).filter((file) =>
      file.endsWith(".old"),
    );
    expect(moved).toHaveLength(1);
    sweepPrevious(exe);
    expect(
      (await readdir(dirname(exe))).filter((file) => file.endsWith(".old")),
    ).toEqual([]);
  });

  it("moves a failed build aside to go back, because it may be held", async () => {
    const exe = await setting();
    await writeFile(`${exe}.next`, "new");
    await swapIn(exe, true);
    await swapBack(exe, true);
    expect(await readFile(exe, "utf8")).toBe("old");
    const moved = (await readdir(dirname(exe))).filter((file) =>
      file.endsWith(".old"),
    );
    expect(moved).toHaveLength(1);
    sweepPrevious(exe);
    expect(await readdir(dirname(exe))).toEqual(["program"]);
  });

  it("does not hide a failure anywhere else", async () => {
    const exe = await setting();
    await writeFile(`${exe}.prev`, "older");
    running.add(`${exe}.prev`);
    await expect(swapIn(exe, false)).rejects.toThrow("EBUSY");
  });
});
