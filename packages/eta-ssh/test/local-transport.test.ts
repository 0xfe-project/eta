import { describe, expect, it } from "vitest";
import { windowsChildEnv, windowsShell } from "../src/local-transport";

const SCOOP = "D:\\Library\\scoop\\apps\\git\\current";
const probe = (
  existing: string[],
  env: Record<string, string | undefined> = {},
  execPath?: string,
) => ({
  env,
  exists: (path: string) => existing.includes(path),
  gitExecPath: () => execPath,
});

describe("windowsShell", () => {
  it("prefers ETA_LOCAL_SHELL", () => {
    expect(
      windowsShell(
        probe(
          [],
          { ETA_LOCAL_SHELL: "E:\\sh.exe" },
          `${SCOOP}\\mingw64\\libexec\\git-core`,
        ),
      ),
    ).toBe("E:\\sh.exe");
  });

  it("derives the root from git --exec-path (scoop shim)", () => {
    const sh = `${SCOOP}\\usr\\bin\\sh.exe`;
    expect(
      windowsShell(
        probe(
          [sh],
          { PATH: "D:\\Library\\scoop\\shims" },
          `${SCOOP.replaceAll("\\", "/")}/mingw64/libexec/git-core\n`,
        ),
      ),
    ).toBe(sh.replaceAll("\\", "/").replaceAll("/", "\\"));
  });

  it("derives the root from git.exe on PATH", () => {
    const sh = "E:\\Git\\usr\\bin\\sh.exe";
    expect(
      windowsShell(
        probe([sh, "E:\\Git\\cmd\\git.exe"], { PATH: "C:\\x;E:\\Git\\cmd" }),
      ),
    ).toBe(sh);
  });

  it("falls back to Program Files", () => {
    const sh = "C:\\Program Files\\Git\\usr\\bin\\sh.exe";
    expect(windowsShell(probe([sh]))).toBe(sh);
  });

  it("explains how to set ETA_LOCAL_SHELL when nothing is found", () => {
    expect(() => windowsShell(probe([]))).toThrow(/ETA_LOCAL_SHELL/);
  });
});

describe("windowsChildEnv", () => {
  it("prepends the shell's usr\\bin and sibling bin", () => {
    expect(windowsChildEnv("E:\\Git\\usr\\bin\\sh.exe", "C:\\p")).toEqual({
      PATH: "E:\\Git\\usr\\bin;E:\\Git\\bin;C:\\p",
    });
  });
});
