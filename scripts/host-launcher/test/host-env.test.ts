import process from "node:process";
import { describe, expect, it } from "vitest";
import { hostEnvironment } from "../host-env";

describe("the environment the packaged app starts its host with", () => {
  it("puts the host's own bin directories ahead of the inherited PATH", () => {
    const { PATH } = hostEnvironment(
      { PATH: "/usr/bin:/bin" },
      "/Users/someone",
    );
    if (process.platform === "win32") {
      expect(PATH).toBe("/usr/bin:/bin");
      return;
    }
    expect(PATH?.startsWith("/Users/someone/.local/bin:")).toBe(true);
    expect(PATH?.endsWith("/usr/bin:/bin")).toBe(true);
  });
});
