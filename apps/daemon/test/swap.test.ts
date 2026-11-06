/** Swapping a file where a hard link cannot be made: the old rename, and its way back. */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { swapIn } from "../src/swap";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  link: () => Promise.reject(new Error("EPERM")),
}));

const dirs: string[] = [];
afterEach(async () => {
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
