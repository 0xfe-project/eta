import { describe, expect, it } from "vitest";
import { gitBashSetup } from "../../src/realm/host-modules";

const GIT = "E:\\Git";
const probe = (
  existing: string[],
  env: Record<string, string | undefined> = {},
) => ({
  env,
  exists: (path: string) => existing.includes(path),
  gitExecPath: () => undefined,
});

describe("gitBashSetup", () => {
  it("picks Git's bash.exe, never the WSL one on PATH", () => {
    const setup = gitBashSetup(
      probe(
        [
          `${GIT}\\usr\\bin\\sh.exe`,
          `${GIT}\\usr\\bin\\bash.exe`,
          `${GIT}\\cmd\\git.exe`,
        ],
        {
          PATH: `C:\\Windows\\System32;${GIT}\\cmd`,
        },
      ),
    );
    expect(setup.shell).toBe(`${GIT}\\usr\\bin\\bash.exe`);
    expect(setup.env.PATH).toBe(
      `${GIT}\\usr\\bin;${GIT}\\bin;C:\\Windows\\System32;${GIT}\\cmd`,
    );
  });

  it("keeps sh.exe when no bash.exe sits next to it", () => {
    const sh = `${GIT}\\usr\\bin\\sh.exe`;
    expect(gitBashSetup(probe([sh], { ETA_LOCAL_SHELL: sh })).shell).toBe(sh);
  });

  it("throws, naming ETA_LOCAL_SHELL, when there is no Git Bash", () => {
    expect(() => gitBashSetup(probe([]))).toThrow(/ETA_LOCAL_SHELL/);
  });
});
