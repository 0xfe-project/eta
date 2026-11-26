import process from "node:process";
import { describe, expect, it } from "vitest";
import { accountFrom, accountName, userNames } from "../user-env";

describe("the user names the app hands on to its host", () => {
  it("fills both when the app was started with neither", () => {
    expect(userNames({}, "mac")).toEqual({ USER: "mac", LOGNAME: "mac" });
  });

  it("leaves the two a login shell already built", () => {
    expect(userNames({ USER: "someone", LOGNAME: "someone" }, "mac")).toEqual(
      {},
    );
  });

  it("fills only the one that is missing", () => {
    expect(userNames({ USER: "someone" }, "mac")).toEqual({ LOGNAME: "mac" });
    expect(userNames({ LOGNAME: "someone" }, "mac")).toEqual({ USER: "mac" });
  });

  it("counts an empty value as missing, which is what launchd hands over", () => {
    expect(userNames({ USER: "", LOGNAME: "" }, "mac")).toEqual({
      USER: "mac",
      LOGNAME: "mac",
    });
  });

  it("does not ask for a name when the environment already carries both", () => {
    const { spawnSync } = Bun;
    let calls = 0;
    Bun.spawnSync = ((...args: Parameters<typeof spawnSync>) => {
      calls += 1;
      return spawnSync(...args);
    }) as typeof spawnSync;
    try {
      expect(userNames({ USER: "someone", LOGNAME: "someone" })).toEqual({});
      expect(calls).toBe(0);
    } finally {
      Bun.spawnSync = spawnSync;
    }
  });

  it("asks for no name at all off macOS, where the bug was never seen", () => {
    expect(accountName("linux")).toBeNull();
    expect(accountName("win32")).toBeNull();
  });

  it("fills nothing when the login name cannot be read", () => {
    expect(userNames({}, null)).toEqual({});
  });

  it("takes a name only from a run of id that succeeded and said one", () => {
    expect(accountFrom({ exitCode: 0, stdout: "mac\n" })).toBe("mac");
    expect(accountFrom({ exitCode: 1, stdout: "mac\n" })).toBeNull();
    expect(accountFrom({ exitCode: 0, stdout: "\n" })).toBeNull();
  });

  it("asks libc for the name, and only does so on macOS", () => {
    if (process.platform !== "darwin") {
      expect(accountName()).toBeNull();
      return;
    }
    const id = Bun.spawnSync(["/usr/bin/id", "-un"]);
    expect(accountName()).toBe(id.stdout.toString().trim());
    expect(accountName()).not.toBe("unknown");
  });
});
