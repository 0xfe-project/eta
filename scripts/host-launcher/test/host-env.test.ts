import process from "node:process";
import { describe, expect, it } from "vitest";
import { hostEnvironment } from "../host-env";

describe("the environment the packaged app starts its host with", () => {
  it("carries the user names macOS left out", () => {
    const { USER, LOGNAME } = hostEnvironment(
      { PATH: "/usr/bin:/bin" },
      "/Users/someone",
    );
    if (process.platform !== "darwin") {
      expect(USER).toBeUndefined();
      expect(LOGNAME).toBeUndefined();
      return;
    }
    const account = Bun.spawnSync(["/usr/bin/id", "-un"]).stdout.toString();
    expect(USER).toBe(account.trim());
    expect(LOGNAME).toBe(account.trim());
  });

  it("keeps the names a terminal already gave the app", () => {
    const { USER, LOGNAME } = hostEnvironment(
      { PATH: "/bin", USER: "someone", LOGNAME: "someone" },
      "/Users/someone",
    );
    expect(USER).toBe("someone");
    expect(LOGNAME).toBe("someone");
  });

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
