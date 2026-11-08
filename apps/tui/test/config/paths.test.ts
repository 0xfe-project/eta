import { posix, resolve, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePaths } from "../../src/config/paths";

describe("resolvePaths", () => {
  it("uses ETA_TUI_CONFIG as the settings file, with the state file beside it", () => {
    const file = resolve("some", "where", "my-tui.json");
    const paths = resolvePaths(
      { ETA_TUI_CONFIG: file, APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
      process.platform,
      "/home/u",
    );
    expect(paths.config).toBe(file);
    expect(paths.state).toBe(resolve("some", "where", "tui-state.json"));
  });

  it("makes a relative ETA_TUI_CONFIG absolute", () => {
    const paths = resolvePaths(
      { ETA_TUI_CONFIG: "rel/tui.json" },
      process.platform,
      "/home/u",
    );
    expect(paths.config).toBe(resolve("rel/tui.json"));
    expect(paths.state).toBe(resolve("rel/tui-state.json"));
  });

  it("ignores an empty ETA_TUI_CONFIG", () => {
    const paths = resolvePaths({ ETA_TUI_CONFIG: "" }, "linux", "/home/u");
    expect(paths.config).toBe("/home/u/.config/eta/tui.json");
  });

  it("puts the files under APPDATA on Windows", () => {
    const paths = resolvePaths(
      { APPDATA: "D:\\Roaming", XDG_CONFIG_HOME: "/x" },
      "win32",
      "C:\\Users\\u",
    );
    expect(paths).toEqual({
      config: "D:\\Roaming\\eta\\tui.json",
      state: "D:\\Roaming\\eta\\tui-state.json",
    });
  });

  it("falls back to the home's AppData\\Roaming on Windows without APPDATA", () => {
    for (const env of [{}, { APPDATA: "" }]) {
      const paths = resolvePaths(env, "win32", "C:\\Users\\u");
      expect(paths).toEqual({
        config: win32.join(
          "C:\\Users\\u",
          "AppData",
          "Roaming",
          "eta",
          "tui.json",
        ),
        state: win32.join(
          "C:\\Users\\u",
          "AppData",
          "Roaming",
          "eta",
          "tui-state.json",
        ),
      });
    }
  });

  it("uses an absolute XDG_CONFIG_HOME elsewhere", () => {
    const paths = resolvePaths(
      { XDG_CONFIG_HOME: "/xdg/conf", APPDATA: "D:\\Roaming" },
      "darwin",
      "/Users/u",
    );
    expect(paths).toEqual({
      config: "/xdg/conf/eta/tui.json",
      state: "/xdg/conf/eta/tui-state.json",
    });
  });

  it("ignores an empty or relative XDG_CONFIG_HOME", () => {
    for (const value of ["", "relative/conf"]) {
      const paths = resolvePaths(
        { XDG_CONFIG_HOME: value },
        "linux",
        "/home/u",
      );
      expect(paths).toEqual({
        config: posix.join("/home/u", ".config", "eta", "tui.json"),
        state: posix.join("/home/u", ".config", "eta", "tui-state.json"),
      });
    }
  });
});
