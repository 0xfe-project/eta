import { describe, expect, it } from "vitest";
import { compareVersions, desktopTooOld } from "../src/desktop";

describe("compareVersions", () => {
  it.each([
    ["0.1.0", "0.1.0", 0],
    ["0.1.0", "0.2.0", -1],
    ["0.10.0", "0.9.0", 1],
    ["1.0.0-rc.1", "1.0.0", -1],
    ["1.0.0-rc.2", "1.0.0-rc.10", -1],
    ["1.0.0-alpha", "1.0.0-beta", -1],
    ["1.0.0-rc.1", "1.0.0-rc.1.1", -1],
    ["1.0.0-1", "1.0.0-alpha", -1],
  ])("%s against %s", (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b) ?? Number.NaN)).toBe(sign);
    expect(Math.sign(compareVersions(b, a) ?? Number.NaN)).toBe(-sign || 0);
  });

  it("has no order for what is not a version", () => {
    expect(compareVersions("dev", "0.1.0")).toBeUndefined();
    expect(compareVersions("0.1", "0.1.0")).toBeUndefined();
  });
});

describe("desktopTooOld", () => {
  it("is an app older than the host's minimum", () => {
    expect(desktopTooOld("0.1.0", "0.2.0")).toBe(true);
    expect(desktopTooOld("0.2.0-rc.1", "0.2.0")).toBe(true);
    expect(desktopTooOld("0.2.0", "0.2.0")).toBe(false);
    expect(desktopTooOld("0.3.0", "0.2.0")).toBe(false);
  });

  it("is not an app it cannot place", () => {
    expect(desktopTooOld(undefined, "9.0.0")).toBe(false);
    expect(desktopTooOld("dev", "9.0.0")).toBe(false);
  });
});
