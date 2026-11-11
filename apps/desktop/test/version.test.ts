import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { buildVersion } from "../src/version";

describe("buildVersion", () => {
  it("is the tag's when a release gives one", () => {
    expect(buildVersion({ ETA_DESKTOP_VERSION: "0.3.0-rc.1" })).toBe(
      "0.3.0-rc.1",
    );
  });

  it("is package.json's otherwise", () => {
    expect(buildVersion({})).toBe(pkg.version);
    expect(buildVersion({ ETA_DESKTOP_VERSION: " " })).toBe(pkg.version);
  });

  it("refuses what is not a version", () => {
    expect(() =>
      buildVersion({ ETA_DESKTOP_VERSION: "desktop-v0.3.0" }),
    ).toThrow("not a version");
  });
});
