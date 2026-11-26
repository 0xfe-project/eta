import { existsSync } from "node:fs";
/** Build commands must use Bun itself, not a shell wrapper that can reject quoted defines. */
import process from "node:process";
import { describe, expect, it } from "vitest";
import { bunExecutable } from "../scripts/bun-executable";

describe("bunExecutable", () => {
  it("names the running Bun executable", () => {
    expect(bunExecutable()).toBe(process.execPath);
    expect(existsSync(bunExecutable())).toBe(true);
  });
});
