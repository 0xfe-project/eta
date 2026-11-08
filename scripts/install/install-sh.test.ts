import type {
  FakeGitHub,
  FakeGitHubOptions,
  RecordedRequest,
} from "./testing/fake-github";
/**
 * `install.sh` run as a program, under `sh` and under `dash` when it is there.
 *
 * Each test has a `HOME` of its own (with a space in its path) and a `PATH` with stand-ins in
 * front: `uname` decides the platform, `gh` never reaches a real login, and where a test needs to
 * see what is sent to github.com, `curl` records its arguments instead of connecting. Requests to
 * any other server go to a fake GitHub API in this process.
 */
import type { Finished } from "./testing/fixtures";
import type { ListedTag } from "./testing/latest-host-cases";
import {
  existsSync,
  linkSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, test } from "bun:test";
import { startFakeGitHub } from "./testing/fake-github";
import {
  cleanEnv,
  fakeTui,
  pathWith,
  posixHost,
  releaseAssets,
  removeTempDirs,
  runToEnd,
  sha256,
  sumsFor,
  tempDir,
  versionLine,
  whichPosix,
  writeFiles,
} from "./testing/fixtures";
import { LATEST_HOST_CASES } from "./testing/latest-host-cases";
import {
  BASE_TOOLS,
  curlProxy,
  curlRecorder,
  ghStub,
  opensslStub,
  readCurlCalls,
  shasumStub,
  sysctlStub,
  toolDir,
  unameStub,
} from "./testing/posix-stubs";

const SCRIPT = join(import.meta.dir, "install.sh");
const ON_WINDOWS = process.platform === "win32";
/** Git Bash starts slowly and forks slowly; a run of the script is several seconds there. */
const TIMEOUT_MS = 60_000;

afterAll(removeTempDirs);

const SH = whichPosix("sh");
if (SH === null && process.env.CI === "1") {
  test("sh is on PATH, which CI=1 requires", () => {
    expect(SH).not.toBeNull();
  });
}

const SHELLS = [
  { name: "sh", path: SH },
  { name: "dash", path: whichPosix("dash") },
];

interface CaseOptions {
  system?: string;
  machine?: string;
  /** What `sysctl -n hw.optional.arm64` says; `null` fails; `undefined` leaves no stand-in. */
  sysctl?: string | null;
  /** What `gh auth token` prints; `null` (the default) fails as a logged-out gh does. */
  ghToken?: string | null;
  /** Set to put the recording `curl` in front, answering every request with this status. */
  curlStatus?: number;
}

interface ShCase {
  home: string;
  /** `$HOME/.eta/bin`, where the script installs. */
  bin: string;
  stubs: string;
  curlLog: string;
  ghLog: string;
  run: (
    args: string[],
    env?: Record<string, string | undefined>,
    path?: string,
  ) => Promise<Finished>;
}

function shCase(shell: string, options: CaseOptions = {}): ShCase {
  const home = tempDir("home");
  const stubs = tempDir("stubs");
  const curlLog = join(stubs, "curl.log");
  const ghLog = join(stubs, "gh.log");
  unameStub(stubs, options.system ?? "Linux", options.machine ?? "x86_64");
  if (options.sysctl !== undefined) sysctlStub(stubs, options.sysctl);
  ghStub(stubs, options.ghToken ?? null, ghLog);
  if (options.curlStatus !== undefined)
    curlRecorder(stubs, curlLog, options.curlStatus);
  return {
    home,
    bin: join(home, ".eta", "bin"),
    stubs,
    curlLog,
    ghLog,
    run: async (args, env = {}, path = pathWith(stubs)) =>
      await runToEnd([shell, SCRIPT, ...args], {
        env: cleanEnv({ HOME: home, SHELL: "/bin/sh", PATH: path, ...env }),
        timeoutMs: TIMEOUT_MS,
      }),
  };
}

/** An installed eta-host is executable; on POSIX a fixture written without the mode is not. */
const EXECUTABLE = 0o755;

const LINUX = { tui: fakeTui("0.3.0"), host: posixHost("0.3.0") };

/** A `--from` directory holding a release for `platform`. */
function fromDir(
  platform = "linux-x64",
  files: { tui: string; host: string } = LINUX,
  sums?: string,
): string {
  const dir = tempDir("from");
  writeFiles(dir, releaseAssets(platform, files, sums));
  return dir;
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

/** What is in the install directory, so a test can see nothing was left behind. */
function entries(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function urlOf(args: string[]): string | undefined {
  return args.find((arg) => /^https?:\/\//.test(arg));
}

for (const shell of SHELLS) {
  const title =
    shell.path === null
      ? `install.sh under ${shell.name} (skipped: ${shell.name} is not on PATH)`
      : `install.sh under ${shell.name}`;
  const shellPath = shell.path ?? shell.name;

  describe.skipIf(shell.path === null)(title, () => {
    describe("the command line", () => {
      test(
        "--help prints the usage to stdout and exits 0",
        async () => {
          const c = shCase(shellPath);
          const result = await c.run(["--help"]);
          expect(result.code).toBe(0);
          expect(result.stderr).toBe("");
          for (const option of [
            "--version",
            "--repo",
            "--from",
            "--force",
            "--add-to-path",
            "--help",
          ])
            expect(result.stdout).toContain(option);
          expect(existsSync(c.bin)).toBe(false);
        },
        TIMEOUT_MS,
      );

      for (const args of [
        ["--bogus"],
        ["extra"],
        ["--version"],
        ["--repo"],
        ["--from"],
        ["--force", "--version"],
      ]) {
        test(
          `${args.join(" ")} is a usage error: usage on stderr, exit 2`,
          async () => {
            const c = shCase(shellPath, { curlStatus: 200 });
            const result = await c.run(args);
            expect(result.code).toBe(2);
            expect(result.stdout).toBe("");
            expect(result.stderr.startsWith("eta install: ")).toBe(true);
            expect(result.stderr).toContain("--add-to-path");
            expect(readCurlCalls(c.curlLog)).toEqual([]);
            expect(existsSync(c.bin)).toBe(false);
          },
          TIMEOUT_MS,
        );
      }

      for (const version of [
        "0.3",
        "0.3.0.1",
        "v0.3.0-",
        "0.3.0+build",
        "x.y.z",
        "vv0.3.0",
        "0.3.0 rc",
      ]) {
        test(
          `--version '${version}' is a usage error`,
          async () => {
            const c = shCase(shellPath, { curlStatus: 200 });
            const result = await c.run(["--version", version]);
            expect(result.code).toBe(2);
            expect(result.stderr.startsWith("eta install: ")).toBe(true);
            expect(readCurlCalls(c.curlLog)).toEqual([]);
          },
          TIMEOUT_MS,
        );
      }

      for (const [given, path] of [
        ["0.3.0", "releases/tags/v0.3.0"],
        ["v0.3.0", "releases/tags/v0.3.0"],
        ["0.3.0-rc.1", "releases/tags/v0.3.0-rc.1"],
        ["v10.20.30-beta.2-x", "releases/tags/v10.20.30-beta.2-x"],
      ] as const) {
        test(
          `--version ${given} asks for ${path}`,
          async () => {
            const c = shCase(shellPath, { curlStatus: 404 });
            await c.run(["--version", given, "--repo", "o/r"]);
            expect(urlOf(readCurlCalls(c.curlLog)[0]?.args ?? [])).toBe(
              `https://api.github.com/repos/o/r/${path}`,
            );
          },
          TIMEOUT_MS,
        );
      }

      test(
        "without --version it asks for the latest release",
        async () => {
          const c = shCase(shellPath, { curlStatus: 404 });
          await c.run(["--repo", "o/r"]);
          expect(urlOf(readCurlCalls(c.curlLog)[0]?.args ?? [])).toBe(
            "https://api.github.com/repos/o/r/releases/latest",
          );
        },
        TIMEOUT_MS,
      );
    });

    describe("the platform", () => {
      for (const [system, machine, platform] of [
        ["Linux", "x86_64", "linux-x64"],
        ["Linux", "amd64", "linux-x64"],
        ["Darwin", "arm64", "darwin-arm64"],
        ["Darwin", "aarch64", "darwin-arm64"],
      ] as const) {
        test(
          `${system} ${machine} installs the ${platform} build`,
          async () => {
            const c = shCase(shellPath, { system, machine });
            const files = {
              tui: fakeTui(platform),
              host: posixHost("0.3.0", platform),
            };
            const result = await c.run(["--from", fromDir(platform, files)]);
            expect(result.code).toBe(0);
            expect(readText(join(c.bin, "eta"))).toBe(files.tui);
            expect(readText(join(c.bin, "eta-host"))).toBe(files.host);
          },
          TIMEOUT_MS,
        );
      }

      test(
        "a shell under Rosetta (Darwin x86_64, hw.optional.arm64 = 1) installs darwin-arm64",
        async () => {
          const c = shCase(shellPath, {
            system: "Darwin",
            machine: "x86_64",
            sysctl: "1",
          });
          const files = {
            tui: fakeTui("mac"),
            host: posixHost("0.3.0", "mac"),
          };
          const result = await c.run([
            "--from",
            fromDir("darwin-arm64", files),
          ]);
          expect(result.code).toBe(0);
          expect(readText(join(c.bin, "eta-host"))).toBe(files.host);
        },
        TIMEOUT_MS,
      );

      for (const [label, options] of [
        [
          "an Intel Mac (hw.optional.arm64 = 0)",
          { system: "Darwin", machine: "x86_64", sysctl: "0" },
        ],
        [
          "an Intel Mac without hw.optional.arm64",
          { system: "Darwin", machine: "x86_64", sysctl: null },
        ],
        ["Linux on arm64", { system: "Linux", machine: "aarch64" }],
        ["Linux on i686", { system: "Linux", machine: "i686" }],
      ] as const) {
        test(
          `${label} has no build: the error names the builds there are`,
          async () => {
            const c = shCase(shellPath, options);
            const dir = tempDir("from");
            writeFiles(dir, {
              ...releaseAssets("linux-x64", LINUX),
              ...releaseAssets("darwin-arm64", LINUX),
            });
            const result = await c.run(["--from", dir]);
            expect(result.code).toBe(1);
            expect(result.stderr.startsWith("eta install: ")).toBe(true);
            expect(result.stderr).toContain("linux-x64");
            expect(result.stderr).toContain("darwin-arm64");
            expect(existsSync(join(c.bin, "eta-host"))).toBe(false);
          },
          TIMEOUT_MS,
        );
      }

      for (const system of [
        "MINGW64_NT-10.0-26100",
        "MSYS_NT-10.0",
        "CYGWIN_NT-10.0",
      ]) {
        test(
          `${system} is Windows: the error says to use install.ps1`,
          async () => {
            const c = shCase(shellPath, { system });
            const result = await c.run(["--from", fromDir()]);
            expect(result.code).toBe(1);
            expect(result.stderr.startsWith("eta install: ")).toBe(true);
            expect(result.stderr).toContain("install.ps1");
            expect(existsSync(join(c.bin, "eta-host"))).toBe(false);
          },
          TIMEOUT_MS,
        );
      }

      test(
        "another system is refused",
        async () => {
          const c = shCase(shellPath, { system: "FreeBSD" });
          const result = await c.run(["--from", fromDir()]);
          expect(result.code).toBe(1);
          expect(result.stderr.startsWith("eta install: ")).toBe(true);
          expect(result.stderr).not.toContain("install.ps1");
          expect(existsSync(join(c.bin, "eta-host"))).toBe(false);
        },
        TIMEOUT_MS,
      );
    });

    describe("--from", () => {
      test(
        "takes the files from the directory without asking any server or gh, whatever --repo says",
        async () => {
          const c = shCase(shellPath, { curlStatus: 200, ghToken: "tok-gh" });
          const result = await c.run(
            ["--from", fromDir(), "--repo", "https://user@nowhere/x?y"],
            { GH_TOKEN: "tok-env" },
          );
          expect(result.code).toBe(0);
          expect(readCurlCalls(c.curlLog)).toEqual([]);
          expect(existsSync(c.ghLog)).toBe(false);
          expect(readText(join(c.bin, "eta"))).toBe(LINUX.tui);
        },
        TIMEOUT_MS,
      );

      test(
        "does not need curl",
        async () => {
          const c = shCase(shellPath);
          const path = tempDir("path");
          toolDir(path, [...BASE_TOOLS, "sha256sum"]);
          unameStub(path, "Linux", "x86_64");
          const result = await c.run(["--from", fromDir()], {}, path);
          expect(result.code).toBe(0);
          expect(readText(join(c.bin, "eta-host"))).toBe(LINUX.host);
        },
        TIMEOUT_MS,
      );

      for (const missing of [
        "SHA256SUMS",
        "eta-linux-x64",
        "eta-host-linux-x64",
      ]) {
        test(
          `a directory without ${missing} is refused, naming it`,
          async () => {
            const c = shCase(shellPath);
            const dir = tempDir("from");
            const assets = releaseAssets("linux-x64", LINUX);
            delete assets[missing];
            writeFiles(dir, assets);
            const result = await c.run(["--from", dir]);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain(missing);
            expect(entries(c.bin)).toEqual([]);
          },
          TIMEOUT_MS,
        );
      }
    });

    describe("which repository and which token", () => {
      for (const given of [
        "o/r",
        "https://github.com/o/r",
        "https://github.com/o/r/",
        "https://api.github.com/repos/o/r",
      ]) {
        test(
          `--repo ${given} is o/r on api.github.com`,
          async () => {
            const c = shCase(shellPath, { curlStatus: 404 });
            await c.run(["--repo", given]);
            expect(urlOf(readCurlCalls(c.curlLog)[0]?.args ?? [])).toBe(
              "https://api.github.com/repos/o/r/releases/latest",
            );
          },
          TIMEOUT_MS,
        );
      }

      test(
        "ETA_RELEASES_URL is taken when there is no --repo",
        async () => {
          const c = shCase(shellPath, { curlStatus: 404 });
          await c.run([], { ETA_RELEASES_URL: "env-owner/env-repo" });
          expect(urlOf(readCurlCalls(c.curlLog)[0]?.args ?? [])).toBe(
            "https://api.github.com/repos/env-owner/env-repo/releases/latest",
          );
        },
        TIMEOUT_MS,
      );

      test(
        "--repo wins over ETA_RELEASES_URL",
        async () => {
          const c = shCase(shellPath, { curlStatus: 404 });
          await c.run(["--repo", "flag/repo"], {
            ETA_RELEASES_URL: "env-owner/env-repo",
          });
          expect(urlOf(readCurlCalls(c.curlLog)[0]?.args ?? [])).toBe(
            "https://api.github.com/repos/flag/repo/releases/latest",
          );
        },
        TIMEOUT_MS,
      );

      test(
        "with neither, it is 0xfe-project/eta",
        async () => {
          const c = shCase(shellPath, { curlStatus: 404 });
          await c.run([]);
          expect(urlOf(readCurlCalls(c.curlLog)[0]?.args ?? [])).toBe(
            "https://api.github.com/repos/0xfe-project/eta/releases/latest",
          );
        },
        TIMEOUT_MS,
      );

      test(
        "any other http(s) address is the API itself, without its trailing slash",
        async () => {
          const c = shCase(shellPath, { curlStatus: 404 });
          await c.run(["--repo", "http://127.0.0.1:9/mirror/eta/"]);
          expect(urlOf(readCurlCalls(c.curlLog)[0]?.args ?? [])).toBe(
            "http://127.0.0.1:9/mirror/eta/releases/latest",
          );
        },
        TIMEOUT_MS,
      );

      for (const given of [
        "https://user@github.com/o/r",
        "https://user:secret@example.com/releases",
        "https://example.com/releases?ref=x",
        "ftp://example.com/o/r",
        "o/r/extra",
        "just words",
      ]) {
        test(
          `--repo '${given}' is refused before any request`,
          async () => {
            const c = shCase(shellPath, { curlStatus: 200 });
            const result = await c.run(["--repo", given]);
            expect(result.code).toBe(1);
            expect(result.stderr.startsWith("eta install: ")).toBe(true);
            expect(readCurlCalls(c.curlLog)).toEqual([]);
          },
          TIMEOUT_MS,
        );
      }

      /** The token each request carried, read from the config `curl` was given on stdin. */
      function bearers(c: ShCase): (string | undefined)[] {
        return readCurlCalls(c.curlLog).map(
          (call) =>
            /Authorization: Bearer ([^"\s]+)/.exec(call.stdin ?? "")?.[1],
        );
      }

      function expectTokenNowhereVisible(
        c: ShCase,
        result: Finished,
        tokens: string[],
      ): void {
        for (const call of readCurlCalls(c.curlLog)) {
          for (const arg of call.args)
            for (const token of tokens) expect(arg).not.toContain(token);
        }
        for (const token of tokens) {
          expect(result.stdout).not.toContain(token);
          expect(result.stderr).not.toContain(token);
        }
      }

      test(
        "github.com gets GH_TOKEN first, on stdin and never as an argument",
        async () => {
          const c = shCase(shellPath, { curlStatus: 404, ghToken: "tok-gh" });
          const result = await c.run(["--repo", "o/r"], {
            GH_TOKEN: "tok-ghtoken",
            GITHUB_TOKEN: "tok-github",
            ETA_RELEASES_TOKEN: "tok-eta",
          });
          expect(bearers(c)[0]).toBe("tok-ghtoken");
          expectTokenNowhereVisible(c, result, [
            "tok-ghtoken",
            "tok-github",
            "tok-gh",
            "tok-eta",
          ]);
        },
        TIMEOUT_MS,
      );

      test(
        "github.com gets GITHUB_TOKEN when there is no GH_TOKEN",
        async () => {
          const c = shCase(shellPath, { curlStatus: 404, ghToken: "tok-gh" });
          const result = await c.run(["--repo", "o/r"], {
            GITHUB_TOKEN: "tok-github",
          });
          expect(bearers(c)[0]).toBe("tok-github");
          expectTokenNowhereVisible(c, result, ["tok-github"]);
        },
        TIMEOUT_MS,
      );

      test(
        "github.com gets gh's token when neither variable is set",
        async () => {
          const c = shCase(shellPath, { curlStatus: 404, ghToken: "tok-gh" });
          const result = await c.run(["--repo", "o/r"]);
          expect(bearers(c)[0]).toBe("tok-gh");
          expect(readText(c.ghLog)).toContain(
            "gh auth token --hostname github.com",
          );
          expectTokenNowhereVisible(c, result, ["tok-gh"]);
        },
        TIMEOUT_MS,
      );

      test(
        "github.com is asked anonymously when gh fails, and ETA_RELEASES_TOKEN is not used for it",
        async () => {
          const c = shCase(shellPath, { curlStatus: 404, ghToken: null });
          const result = await c.run(["--repo", "o/r"], {
            ETA_RELEASES_TOKEN: "tok-eta",
          });
          const calls = readCurlCalls(c.curlLog);
          expect(calls.length).toBeGreaterThan(0);
          expect(bearers(c)).toEqual(calls.map(() => undefined));
          expectTokenNowhereVisible(c, result, ["tok-eta"]);
        },
        TIMEOUT_MS,
      );

      test(
        "github.com is asked anonymously when gh is not on PATH",
        async () => {
          const c = shCase(shellPath, { curlStatus: 404 });
          const path = tempDir("path");
          toolDir(path, [...BASE_TOOLS, "sha256sum"]);
          unameStub(path, "Linux", "x86_64");
          curlRecorder(path, c.curlLog, 404);
          const result = await c.run(["--repo", "o/r"], {}, path);
          expect(result.code).toBe(1);
          const calls = readCurlCalls(c.curlLog);
          expect(calls.length).toBeGreaterThan(0);
          expect(bearers(c)).toEqual(calls.map(() => undefined));
        },
        TIMEOUT_MS,
      );

      test(
        "another server never gets GH_TOKEN, GITHUB_TOKEN or gh's token",
        async () => {
          const c = shCase(shellPath, { curlStatus: 404, ghToken: "tok-gh" });
          const result = await c.run(["--repo", "http://127.0.0.1:9/x/y"], {
            GH_TOKEN: "tok-ghtoken",
            GITHUB_TOKEN: "tok-github",
          });
          const calls = readCurlCalls(c.curlLog);
          expect(calls.length).toBeGreaterThan(0);
          expect(bearers(c)).toEqual(calls.map(() => undefined));
          expect(existsSync(c.ghLog)).toBe(false);
          expectTokenNowhereVisible(c, result, [
            "tok-ghtoken",
            "tok-github",
            "tok-gh",
          ]);
        },
        TIMEOUT_MS,
      );

      test(
        "another server gets ETA_RELEASES_TOKEN",
        async () => {
          const c = shCase(shellPath, { curlStatus: 404 });
          const result = await c.run(["--repo", "http://127.0.0.1:9/x/y"], {
            ETA_RELEASES_TOKEN: "tok-eta",
          });
          expect(bearers(c)[0]).toBe("tok-eta");
          expectTokenNowhereVisible(c, result, ["tok-eta"]);
        },
        TIMEOUT_MS,
      );

      for (const status of [401, 403, 404]) {
        test(
          `${status} without a token on github.com says the repository may be private, and how to log in`,
          async () => {
            const c = shCase(shellPath, { curlStatus: status });
            const result = await c.run(["--repo", "o/r"]);
            expect(result.code).toBe(1);
            expect(result.stderr.startsWith("eta install: ")).toBe(true);
            expect(result.stderr).toContain(String(status));
            expect(result.stderr).toContain("private");
            expect(result.stderr).toContain("gh auth login");
            expect(result.stderr).toContain("GH_TOKEN");
          },
          TIMEOUT_MS,
        );

        test(
          `${status} without a token on another server points at ETA_RELEASES_TOKEN only`,
          async () => {
            const c = shCase(shellPath, { curlStatus: status });
            const result = await c.run(["--repo", "http://127.0.0.1:9/x/y"]);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain(String(status));
            expect(result.stderr).toContain("ETA_RELEASES_TOKEN");
            expect(result.stderr).not.toContain("gh auth login");
            expect(result.stderr).not.toContain("GH_TOKEN");
          },
          TIMEOUT_MS,
        );
      }

      test(
        "404 with a token gives the status without the hint for a missing token",
        async () => {
          const c = shCase(shellPath, { curlStatus: 404 });
          const result = await c.run(["--repo", "o/r"], {
            GH_TOKEN: "tok-ghtoken",
          });
          expect(result.code).toBe(1);
          expect(result.stderr).toContain("404");
          expect(result.stderr).not.toContain("gh auth login");
          expect(result.stderr).not.toContain("tok-ghtoken");
        },
        TIMEOUT_MS,
      );

      test(
        "without curl a download is refused, naming curl",
        async () => {
          const c = shCase(shellPath);
          const path = tempDir("path");
          toolDir(path, [...BASE_TOOLS, "sha256sum"]);
          unameStub(path, "Linux", "x86_64");
          const result = await c.run(["--repo", "o/r"], {}, path);
          expect(result.code).toBe(1);
          expect(result.stderr.startsWith("eta install: ")).toBe(true);
          expect(result.stderr).toContain("curl");
        },
        TIMEOUT_MS,
      );
    });

    describe("downloading from a server", () => {
      const assets = releaseAssets("linux-x64", LINUX);

      function withoutAuth(requests: RecordedRequest[]) {
        return requests.filter((request) => request.authorization === null);
      }

      test(
        "installs the release, with the token on the API and none on the signed address",
        async () => {
          const server = startFakeGitHub({
            releases: [{ tag: "v0.3.0", assets }],
            latest: "v0.3.0",
          });
          try {
            const c = shCase(shellPath);
            const result = await c.run(["--repo", server.api], {
              ETA_RELEASES_TOKEN: "tok-eta",
              GH_TOKEN: "tok-ghtoken",
            });
            expect(result.stderr).toBe("");
            expect(result.code).toBe(0);
            expect(readText(join(c.bin, "eta"))).toBe(LINUX.tui);
            expect(readText(join(c.bin, "eta-host"))).toBe(LINUX.host);

            const api = server.requests.filter((r) =>
              r.path.startsWith("/repos/"),
            );
            const signed = server.requests.filter((r) =>
              r.path.startsWith("/signed/"),
            );
            expect(api[0]).toEqual({
              path: "/repos/o/r/releases/latest",
              authorization: "Bearer tok-eta",
              accept: "application/vnd.github+json",
              userAgent: "eta-install",
            });
            const assetRequests = api.slice(1);
            expect(assetRequests.map((r) => r.path).sort()).toEqual(
              Object.keys(assets)
                .map((name) => `/repos/o/r/releases/assets/v0.3.0/${name}`)
                .sort(),
            );
            for (const request of assetRequests) {
              expect(request.authorization).toBe("Bearer tok-eta");
              expect(request.accept).toBe("application/octet-stream");
              expect(request.userAgent).toBe("eta-install");
            }
            expect(signed).toHaveLength(3);
            expect(withoutAuth(signed)).toHaveLength(3);
            for (const request of server.requests)
              expect(request.authorization ?? "").not.toContain("tok-ghtoken");
          } finally {
            await server.stop();
          }
        },
        TIMEOUT_MS,
      );

      test(
        "reads a release written over many lines",
        async () => {
          const server = startFakeGitHub({
            releases: [{ tag: "v0.3.0", assets }],
            latest: "v0.3.0",
            pretty: true,
          });
          try {
            const c = shCase(shellPath);
            const result = await c.run(["--repo", server.api]);
            expect(result.code).toBe(0);
            expect(readText(join(c.bin, "eta-host"))).toBe(LINUX.host);
            expect(
              server.requests.some((r) => r.path.startsWith("/decoy/")),
            ).toBe(false);
            expect(
              server.requests.some((r) => r.path.startsWith("/users/")),
            ).toBe(false);
          } finally {
            await server.stop();
          }
        },
        TIMEOUT_MS,
      );

      test(
        "--version asks for that tag",
        async () => {
          const older = releaseAssets("linux-x64", {
            tui: fakeTui("0.2.0"),
            host: posixHost("0.2.0"),
          });
          const server = startFakeGitHub({
            releases: [
              { tag: "v0.2.0", assets: older },
              { tag: "v0.3.0", assets },
            ],
            latest: "v0.3.0",
          });
          try {
            const c = shCase(shellPath);
            const result = await c.run([
              "--repo",
              server.api,
              "--version",
              "v0.2.0",
            ]);
            expect(result.code).toBe(0);
            expect(server.requests[0]?.path).toBe(
              "/repos/o/r/releases/tags/v0.2.0",
            );
            expect(readText(join(c.bin, "eta-host"))).toBe(
              older["eta-host-linux-x64"] as string,
            );
          } finally {
            await server.stop();
          }
        },
        TIMEOUT_MS,
      );

      test(
        "a draft is refused and nothing is downloaded",
        async () => {
          const server = startFakeGitHub({
            releases: [{ tag: "v0.3.0", assets, draft: true }],
            latest: "v0.3.0",
          });
          try {
            const c = shCase(shellPath);
            const result = await c.run(["--repo", server.api]);
            expect(result.code).toBe(1);
            expect(result.stderr.startsWith("eta install: ")).toBe(true);
            expect(
              server.requests.some((r) => r.path.startsWith("/signed/")),
            ).toBe(false);
            expect(entries(c.bin)).toEqual([]);
          } finally {
            await server.stop();
          }
        },
        TIMEOUT_MS,
      );

      test(
        "a release without some of the files is refused, naming each missing one",
        async () => {
          const server = startFakeGitHub({
            releases: [
              {
                tag: "v0.3.0",
                assets: {
                  "eta-host-linux-x64": LINUX.host,
                  "eta-linux-x64.sig": "x",
                  "SHA256SUMS.old": "x",
                },
              },
            ],
            latest: "v0.3.0",
          });
          try {
            const c = shCase(shellPath);
            const result = await c.run(["--repo", server.api]);
            expect(result.code).toBe(1);
            expect(result.stderr).toMatch(/eta-linux-x64(?!\.)/);
            expect(result.stderr).toMatch(/SHA256SUMS(?!\.)/);
            expect(result.stderr).not.toContain("eta-host-linux-x64");
            expect(entries(c.bin)).toEqual([]);
          } finally {
            await server.stop();
          }
        },
        TIMEOUT_MS,
      );

      test(
        "a failed release request gives its status, and not the token the server echoes",
        async () => {
          const server = startFakeGitHub({
            releases: [],
            override: (path, request) =>
              path.endsWith("/releases/latest")
                ? new Response(
                    `bad gateway for ${request.headers.get("authorization")}`,
                    {
                      status: 502,
                    },
                  )
                : undefined,
          });
          try {
            const c = shCase(shellPath);
            const result = await c.run(["--repo", server.api], {
              ETA_RELEASES_TOKEN: "tok-eta",
            });
            expect(result.code).toBe(1);
            expect(result.stderr).toContain("502");
            expect(result.stderr).not.toContain("tok-eta");
            expect(result.stdout).not.toContain("tok-eta");
          } finally {
            await server.stop();
          }
        },
        TIMEOUT_MS,
      );

      test(
        "a failed download gives its status and installs nothing",
        async () => {
          const server = startFakeGitHub({
            releases: [{ tag: "v0.3.0", assets }],
            latest: "v0.3.0",
            override: (path) =>
              path.endsWith("/eta-host-linux-x64") &&
              path.startsWith("/signed/")
                ? new Response("unavailable", { status: 503 })
                : undefined,
          });
          try {
            const c = shCase(shellPath);
            const result = await c.run(["--repo", server.api]);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain("503");
            expect(entries(c.bin)).toEqual([]);
          } finally {
            await server.stop();
          }
        },
        TIMEOUT_MS,
      );

      test(
        "a server that cannot be reached is an error",
        async () => {
          const server = startFakeGitHub({ releases: [] });
          const api = server.api;
          await server.stop();
          const c = shCase(shellPath);
          const result = await c.run(["--repo", api]);
          expect(result.code).toBe(1);
          expect(result.stderr.startsWith("eta install: ")).toBe(true);
          expect(entries(c.bin)).toEqual([]);
        },
        TIMEOUT_MS,
      );
    });

    describe("which release an install without --version takes", () => {
      const LIST_URL = "/repos/o/r/releases?per_page=100";

      /** A release's files whose bytes name its tag, so what was installed says where it came from. */
      function assetsOf(tag: string): Record<string, Uint8Array | string> {
        return releaseAssets("linux-x64", {
          tui: fakeTui(tag),
          host: posixHost(tag.slice(1)),
        });
      }

      function serverFor(
        releases: ListedTag[],
        latest: string | undefined,
        extra: Partial<FakeGitHubOptions> = {},
      ): FakeGitHub {
        return startFakeGitHub({
          releases: releases.map((release) => ({
            ...release,
            assets: assetsOf(release.tag),
          })),
          latest,
          ...extra,
        });
      }

      function tokenOf(call: {
        stdin: string | undefined;
      }): string | undefined {
        return /Authorization: Bearer ([^"\s]+)/.exec(call.stdin ?? "")?.[1];
      }

      const OLD = { tui: fakeTui("old"), host: posixHost("0.1.0") };

      for (const row of LATEST_HOST_CASES) {
        test(
          `${row.name}: ${row.installs === null ? "fails" : `installs ${row.installs}`}`,
          async () => {
            const server = serverFor(row.releases, row.latest);
            try {
              const c = shCase(shellPath);
              writeFiles(
                c.bin,
                { eta: OLD.tui, "eta-host": OLD.host },
                EXECUTABLE,
              );
              const result = await c.run(["--repo", server.api, "--force"]);
              const why = `${row.why}\nstderr: ${result.stderr}`;
              expect(
                server.urls.filter((url) =>
                  url.startsWith("/repos/o/r/releases?"),
                ),
                why,
              ).toEqual(row.listed ? [LIST_URL] : []);
              expect(server.urls[0], why).toBe("/repos/o/r/releases/latest");
              expect(
                server.urls.some((url) => url.includes("v9.9.9")),
                why,
              ).toBe(false);
              if (row.installs === null) {
                expect(result.code, why).toBe(1);
                expect(result.stderr.startsWith("eta install: ")).toBe(true);
                expect(result.stderr).toContain(
                  "has no host release (a v* tag)",
                );
                expect(result.stderr).toContain("--version");
                expect(
                  server.urls.filter(
                    (url) =>
                      url.includes("/releases/tags/") ||
                      url.includes("/releases/assets/") ||
                      url.startsWith("/signed/"),
                  ),
                ).toEqual([]);
                expect(entries(c.bin)).toEqual(["eta", "eta-host"]);
                expect(readText(join(c.bin, "eta"))).toBe(OLD.tui);
                expect(readText(join(c.bin, "eta-host"))).toBe(OLD.host);
                return;
              }
              expect(result.code, why).toBe(0);
              expect(result.stderr).toBe("");
              expect(readText(join(c.bin, "eta"))).toBe(fakeTui(row.installs));
              expect(readText(join(c.bin, "eta-host"))).toBe(
                posixHost(row.installs.slice(1)),
              );
              const downloads = server.urls.filter((url) =>
                url.includes("/releases/assets/"),
              );
              expect(downloads).toHaveLength(3);
              for (const url of downloads)
                expect(url).toContain(`/releases/assets/${row.installs}/`);
            } finally {
              await server.stop();
            }
          },
          TIMEOUT_MS,
        );
      }

      test(
        "a latest release that fails otherwise than with 404 is an error, and the list is not asked for",
        async () => {
          const server = serverFor([{ tag: "v0.3.0" }], undefined, {
            override: (path) =>
              path.endsWith("/releases/latest")
                ? new Response("boom", { status: 500 })
                : undefined,
          });
          try {
            const c = shCase(shellPath);
            const result = await c.run(["--repo", server.api]);
            expect(result.code).toBe(1);
            expect(result.stderr.startsWith("eta install: ")).toBe(true);
            expect(result.stderr).toContain("500");
            expect(server.urls).toEqual(["/repos/o/r/releases/latest"]);
            expect(entries(c.bin)).toEqual([]);
          } finally {
            await server.stop();
          }
        },
        TIMEOUT_MS,
      );

      for (const [label, answer] of [
        ["empty", ""],
        ["only white space", " \r\n\t "],
        ["null", "null"],
      ] as const) {
        test(
          `a latest release whose answer is ${label} is an error, and the list is not asked for`,
          async () => {
            const server = serverFor([{ tag: "v0.3.0" }], undefined, {
              override: (path) =>
                path.endsWith("/releases/latest")
                  ? new Response(answer, {
                      headers: { "content-type": "application/json" },
                    })
                  : undefined,
            });
            try {
              const c = shCase(shellPath);
              const result = await c.run(["--repo", server.api]);
              expect(result.code).toBe(1);
              expect(result.stderr.startsWith("eta install: ")).toBe(true);
              expect(result.stderr).toContain(
                "the answer is not a release as GitHub's API writes it",
              );
              expect(server.urls).toEqual(["/repos/o/r/releases/latest"]);
              expect(entries(c.bin)).toEqual([]);
            } finally {
              await server.stop();
            }
          },
          TIMEOUT_MS,
        );
      }

      for (const status of [401, 403]) {
        test(
          `a list that answers ${status} without a token on another server points at ETA_RELEASES_TOKEN`,
          async () => {
            const server = serverFor([{ tag: "v0.3.0" }], undefined, {
              override: (path) =>
                path.endsWith("/releases")
                  ? new Response("no", { status })
                  : undefined,
            });
            try {
              const c = shCase(shellPath);
              const result = await c.run(["--repo", server.api]);
              expect(result.code).toBe(1);
              expect(result.stderr.startsWith("eta install: ")).toBe(true);
              expect(result.stderr).toContain(String(status));
              expect(result.stderr).toContain("private");
              expect(result.stderr).toContain("ETA_RELEASES_TOKEN");
              expect(server.urls).toEqual([
                "/repos/o/r/releases/latest",
                LIST_URL,
              ]);
              expect(entries(c.bin)).toEqual([]);
            } finally {
              await server.stop();
            }
          },
          TIMEOUT_MS,
        );

        test(
          `a list that answers ${status} without a token on github.com says the repository may be private`,
          async () => {
            const c = shCase(shellPath);
            curlRecorder(c.stubs, c.curlLog, 404, status);
            const result = await c.run(["--repo", "o/r"]);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain(String(status));
            expect(result.stderr).toContain("private");
            expect(result.stderr).toContain("gh auth login");
            expect(
              readCurlCalls(c.curlLog).map((call) => urlOf(call.args)),
            ).toEqual([
              "https://api.github.com/repos/o/r/releases/latest",
              "https://api.github.com/repos/o/r/releases?per_page=100",
            ]);
          },
          TIMEOUT_MS,
        );
      }

      test(
        "on github.com the list gets the token too, on stdin, and curl starts with -q",
        async () => {
          const c = shCase(shellPath);
          curlRecorder(c.stubs, c.curlLog, 404, 403);
          const result = await c.run(["--repo", "o/r"], {
            GH_TOKEN: "tok-ghtoken",
          });
          expect(result.code).toBe(1);
          const calls = readCurlCalls(c.curlLog);
          expect(calls.map((call) => urlOf(call.args))).toEqual([
            "https://api.github.com/repos/o/r/releases/latest",
            "https://api.github.com/repos/o/r/releases?per_page=100",
          ]);
          for (const call of calls) {
            expect(call.args[0]).toBe("-q");
            expect(tokenOf(call)).toBe("tok-ghtoken");
            for (const arg of call.args)
              expect(arg).not.toContain("tok-ghtoken");
          }
          expect(result.stderr).toContain("403");
          expect(result.stderr).not.toContain("tok-ghtoken");
          expect(result.stderr).not.toContain("gh auth login");
        },
        TIMEOUT_MS,
      );

      for (const [label, answer] of [
        ["an object", '{"tag_name":"v0.3.0","draft":false,"assets":[]}'],
        ["broken JSON", '[{"tag_name":"v0.3.0"'],
        ["not JSON", "<html>rate limited</html>"],
      ] as const) {
        test(
          `a list that is ${label} is an error, and nothing is installed`,
          async () => {
            const server = serverFor([{ tag: "v0.3.0" }], undefined, {
              override: (path) =>
                path.endsWith("/releases")
                  ? new Response(answer, {
                      headers: { "content-type": "application/json" },
                    })
                  : undefined,
            });
            try {
              const c = shCase(shellPath);
              const result = await c.run(["--repo", server.api]);
              expect(result.code).toBe(1);
              expect(result.stderr.startsWith("eta install: ")).toBe(true);
              expect(result.stderr).toContain("list");
              expect(server.urls).toEqual([
                "/repos/o/r/releases/latest",
                LIST_URL,
              ]);
              expect(entries(c.bin)).toEqual([]);
            } finally {
              await server.stop();
            }
          },
          TIMEOUT_MS,
        );
      }

      test(
        "a list written over many lines is read as well",
        async () => {
          const server = serverFor(
            [{ tag: "desktop-v0.5.0" }, { tag: "v0.9.9" }, { tag: "v0.10.0" }],
            "desktop-v0.5.0",
            { pretty: true },
          );
          try {
            const c = shCase(shellPath);
            const result = await c.run(["--repo", server.api]);
            expect(result.stderr).toBe("");
            expect(result.code).toBe(0);
            expect(readText(join(c.bin, "eta"))).toBe(fakeTui("v0.10.0"));
          } finally {
            await server.stop();
          }
        },
        TIMEOUT_MS,
      );

      test(
        "--version still takes that tag, and a draft there is refused",
        async () => {
          const server = serverFor(
            [{ tag: "v0.3.0", draft: true }, { tag: "v0.2.0" }],
            "v0.2.0",
          );
          try {
            const c = shCase(shellPath);
            const result = await c.run([
              "--repo",
              server.api,
              "--version",
              "0.3.0",
            ]);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain("draft");
            expect(server.urls).toEqual(["/repos/o/r/releases/tags/v0.3.0"]);
            expect(entries(c.bin)).toEqual([]);
          } finally {
            await server.stop();
          }
        },
        TIMEOUT_MS,
      );
    });

    describe("checking the files", () => {
      const OLD = { tui: fakeTui("old"), host: posixHost("0.2.0") };

      function installOld(c: ShCase): void {
        writeFiles(c.bin, { eta: OLD.tui, "eta-host": OLD.host }, EXECUTABLE);
      }

      function expectOldUntouched(c: ShCase): void {
        expect(entries(c.bin)).toEqual(["eta", "eta-host"]);
        expect(readText(join(c.bin, "eta"))).toBe(OLD.tui);
        expect(readText(join(c.bin, "eta-host"))).toBe(OLD.host);
      }

      test(
        "an eta-host that does not match SHA256SUMS is refused, naming it, and nothing is touched",
        async () => {
          const c = shCase(shellPath);
          installOld(c);
          const sums = sumsFor({
            "eta-linux-x64": LINUX.tui,
            "eta-host-linux-x64": `${LINUX.host}tampered`,
          });
          const result = await c.run([
            "--from",
            fromDir("linux-x64", LINUX, sums),
            "--force",
          ]);
          expect(result.code).toBe(1);
          expect(result.stderr).toContain("eta-host-linux-x64");
          expectOldUntouched(c);
        },
        TIMEOUT_MS,
      );

      test(
        "eta without a line in SHA256SUMS is refused, naming it, and nothing is touched",
        async () => {
          const c = shCase(shellPath);
          installOld(c);
          const sums = sumsFor({ "eta-host-linux-x64": LINUX.host });
          const result = await c.run([
            "--from",
            fromDir("linux-x64", LINUX, sums),
            "--force",
          ]);
          expect(result.code).toBe(1);
          expect(result.stderr).toMatch(/eta-linux-x64/);
          expectOldUntouched(c);
        },
        TIMEOUT_MS,
      );

      test(
        "a line for the same name under a directory does not count",
        async () => {
          const c = shCase(shellPath);
          const sums = `${sha256(LINUX.tui)}  eta-linux-x64\n${sha256(LINUX.host)}  dist/eta-host-linux-x64\n${"0".repeat(64)}  eta-host-linux-x64\n`;
          const result = await c.run([
            "--from",
            fromDir("linux-x64", LINUX, sums),
          ]);
          expect(result.code).toBe(1);
          expect(result.stderr).toContain("eta-host-linux-x64");
          expect(entries(c.bin)).toEqual([]);
        },
        TIMEOUT_MS,
      );

      test(
        "takes the binary-mode form '<hex> *<name>', upper-case hex, and CRLF line ends",
        async () => {
          const c = shCase(shellPath);
          const sums = `${sha256(LINUX.tui).toUpperCase()} *eta-linux-x64\r\n${sha256(LINUX.host)} *eta-host-linux-x64\r\n`;
          const result = await c.run([
            "--from",
            fromDir("linux-x64", LINUX, sums),
          ]);
          expect(result.stderr).toBe("");
          expect(result.code).toBe(0);
        },
        TIMEOUT_MS,
      );

      for (const [label, stub] of [
        ["shasum -a 256", shasumStub],
        ["openssl dgst -sha256", opensslStub],
      ] as const) {
        test(
          `without sha256sum it checks with ${label}, and still catches a mismatch`,
          async () => {
            const c = shCase(shellPath);
            const path = tempDir("path");
            toolDir(path, BASE_TOOLS);
            unameStub(path, "Linux", "x86_64");
            stub(path);
            const good = await c.run(["--from", fromDir()], {}, path);
            expect(good.stderr).toBe("");
            expect(good.code).toBe(0);

            const other = shCase(shellPath);
            const sums = sumsFor({
              "eta-linux-x64": `${LINUX.tui}x`,
              "eta-host-linux-x64": LINUX.host,
            });
            const bad = await other.run(
              ["--from", fromDir("linux-x64", LINUX, sums)],
              {},
              path,
            );
            expect(bad.code).toBe(1);
            expect(bad.stderr).toContain("eta-linux-x64");
          },
          TIMEOUT_MS,
        );
      }

      test(
        "with no hash tool at all it is refused",
        async () => {
          const c = shCase(shellPath);
          const path = tempDir("path");
          toolDir(path, BASE_TOOLS);
          unameStub(path, "Linux", "x86_64");
          const result = await c.run(["--from", fromDir()], {}, path);
          expect(result.code).toBe(1);
          expect(result.stderr).toContain("sha256sum");
          expect(entries(c.bin)).toEqual([]);
        },
        TIMEOUT_MS,
      );

      for (const [label, host] of [
        [
          "fails",
          `#!/bin/sh\necho "cannot execute: Exec format error" >&2\nexit 126\n`,
        ],
        ["prints something else", `#!/bin/sh\necho "eta 0.3.0"\n`],
      ] as const) {
        test(
          `a downloaded eta-host that ${label} on --version is refused with its output, and nothing is installed`,
          async () => {
            const c = shCase(shellPath);
            installOld(c);
            const files = { tui: LINUX.tui, host };
            const result = await c.run([
              "--from",
              fromDir("linux-x64", files),
              "--force",
            ]);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain("does not run on this machine");
            expect(result.stderr).toContain(
              label === "fails" ? "Exec format error" : "eta 0.3.0",
            );
            expectOldUntouched(c);
          },
          TIMEOUT_MS,
        );
      }

      test(
        "the files wait in a directory inside the install directory, which is gone afterwards",
        async () => {
          const c = shCase(shellPath);
          const seen = join(c.home, "seen");
          const host = `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' "$0" >> "$HOME/seen"; echo "${versionLine("0.3.0")}"; fi\n`;
          const result = await c.run([
            "--from",
            fromDir("linux-x64", { tui: LINUX.tui, host }),
          ]);
          expect(result.code).toBe(0);
          const first = readText(seen).split("\n")[0] ?? "";
          expect(first).toMatch(/\/\.eta\/bin\/[^/]+\/eta-host-linux-x64$/);
          expect(entries(c.bin)).toEqual(["eta", "eta-host"]);
        },
        TIMEOUT_MS,
      );
    });

    describe("putting the files in place", () => {
      test(
        "a first install puts both in $HOME/.eta/bin and says where, with the host's version",
        async () => {
          const c = shCase(shellPath);
          const result = await c.run(["--from", fromDir()]);
          expect(result.code).toBe(0);
          expect(entries(c.bin)).toEqual(["eta", "eta-host"]);
          expect(readText(join(c.bin, "eta"))).toBe(LINUX.tui);
          expect(readText(join(c.bin, "eta-host"))).toBe(LINUX.host);
          expect(result.stdout).toMatch(/\.eta\/bin\/eta(?!-)/);
          expect(result.stdout).toContain(".eta/bin/eta-host");
          expect(result.stdout).toContain(versionLine("0.3.0"));
          if (!ON_WINDOWS) {
            expect(statSync(join(c.bin, "eta")).mode & 0o777).toBe(0o755);
            expect(statSync(join(c.bin, "eta-host")).mode & 0o777).toBe(0o755);
          }
        },
        TIMEOUT_MS,
      );

      test(
        "an eta-host with the same --version is left as it is, and eta is replaced",
        async () => {
          const c = shCase(shellPath);
          const sameVersion = posixHost(
            "0.3.0",
            "an older build of the same version",
          );
          writeFiles(
            c.bin,
            { eta: fakeTui("old"), "eta-host": sameVersion },
            EXECUTABLE,
          );
          const result = await c.run(["--from", fromDir()]);
          expect(result.code).toBe(0);
          expect(readText(join(c.bin, "eta-host"))).toBe(sameVersion);
          expect(readText(join(c.bin, "eta"))).toBe(LINUX.tui);
          expect(result.stdout).toContain("already");
          expect(result.stdout).toContain(versionLine("0.3.0"));
        },
        TIMEOUT_MS,
      );

      test(
        "an eta-host of another version is not replaced without --force: exit 0, and stderr says how",
        async () => {
          const c = shCase(shellPath);
          const old = posixHost("0.2.0");
          writeFiles(
            c.bin,
            { eta: fakeTui("old"), "eta-host": old },
            EXECUTABLE,
          );
          const result = await c.run(["--from", fromDir()]);
          expect(result.code).toBe(0);
          expect(readText(join(c.bin, "eta-host"))).toBe(old);
          expect(readText(join(c.bin, "eta"))).toBe(LINUX.tui);
          expect(result.stderr).toContain(versionLine("0.2.0"));
          expect(result.stderr).toContain(versionLine("0.3.0"));
          expect(result.stderr).toContain("eta-host upgrade");
          expect(result.stderr).toContain("--force");
        },
        TIMEOUT_MS,
      );

      test(
        "an eta-host that does not run counts as another version",
        async () => {
          const c = shCase(shellPath);
          const broken = `#!/bin/sh\nexit 1\n`;
          writeFiles(c.bin, { "eta-host": broken }, EXECUTABLE);
          const result = await c.run(["--from", fromDir()]);
          expect(result.code).toBe(0);
          expect(readText(join(c.bin, "eta-host"))).toBe(broken);
          expect(result.stderr).toContain("--force");
          expect(result.stderr).toContain(versionLine("0.3.0"));
        },
        TIMEOUT_MS,
      );

      test(
        "--force replaces it by a rename, so a process holding the old file keeps it, and says to restart",
        async () => {
          const c = shCase(shellPath);
          const old = posixHost("0.2.0");
          writeFiles(c.bin, { "eta-host": old }, EXECUTABLE);
          const held = join(c.home, "held");
          linkSync(join(c.bin, "eta-host"), held);
          const result = await c.run(["--from", fromDir(), "--force"]);
          expect(result.code).toBe(0);
          expect(readText(join(c.bin, "eta-host"))).toBe(LINUX.host);
          expect(readText(held)).toBe(old);
          expect(`${result.stdout}${result.stderr}`).toMatch(/restart/i);
          if (!ON_WINDOWS)
            expect(statSync(join(c.bin, "eta-host")).mode & 0o777).toBe(0o755);
        },
        TIMEOUT_MS,
      );

      test(
        "eta is replaced by a rename as well",
        async () => {
          const c = shCase(shellPath);
          const old = fakeTui("old");
          writeFiles(c.bin, { eta: old });
          const held = join(c.home, "held");
          linkSync(join(c.bin, "eta"), held);
          const result = await c.run(["--from", fromDir()]);
          expect(result.code).toBe(0);
          expect(readText(join(c.bin, "eta"))).toBe(LINUX.tui);
          expect(readText(held)).toBe(old);
        },
        TIMEOUT_MS,
      );
    });

    describe("PATH", () => {
      const PROFILE_LINE = `export PATH="$HOME/.eta/bin:$PATH"`;
      const FISH_LINE = `fish_add_path -g "$HOME/.eta/bin"`;

      test(
        "says nothing about PATH when the install directory is on it",
        async () => {
          const c = shCase(shellPath);
          const result = await c.run(
            ["--from", fromDir()],
            { SHELL: "/bin/zsh" },
            pathWith(c.stubs, c.bin),
          );
          expect(result.code).toBe(0);
          expect(result.stdout).not.toContain("PATH");
          expect(result.stdout).not.toContain("--add-to-path");
          expect(existsSync(join(c.home, ".zshrc"))).toBe(false);
        },
        TIMEOUT_MS,
      );

      test(
        "an entry that only starts with the install directory does not count",
        async () => {
          const c = shCase(shellPath);
          const result = await c.run(
            ["--from", fromDir()],
            {},
            pathWith(c.stubs, `${c.bin}-old`),
          );
          expect(result.code).toBe(0);
          expect(result.stdout).toContain("--add-to-path");
        },
        TIMEOUT_MS,
      );

      for (const [shellName, system, file, line] of [
        ["/bin/zsh", "Linux", ".zshrc", PROFILE_LINE],
        ["/usr/bin/bash", "Linux", ".bashrc", PROFILE_LINE],
        ["/bin/bash", "Darwin", ".bash_profile", PROFILE_LINE],
        [
          "/usr/local/bin/fish",
          "Linux",
          ".config/fish/conf.d/eta.fish",
          FISH_LINE,
        ],
        ["/bin/ksh", "Linux", ".profile", PROFILE_LINE],
        ["", "Linux", ".profile", PROFILE_LINE],
      ] as const) {
        const machine = system === "Darwin" ? "arm64" : "x86_64";
        const platform = system === "Darwin" ? "darwin-arm64" : "linux-x64";

        test(
          `SHELL='${shellName}' on ${system}: prints the line for ~/${file} and --add-to-path, and writes nothing`,
          async () => {
            const c = shCase(shellPath, { system, machine });
            const result = await c.run(["--from", fromDir(platform)], {
              SHELL: shellName,
            });
            expect(result.code).toBe(0);
            expect(result.stdout).toContain(line);
            expect(result.stdout).toContain(file.split("/").at(-1) ?? file);
            expect(result.stdout).toContain("--add-to-path");
            expect(existsSync(join(c.home, file))).toBe(false);
          },
          TIMEOUT_MS,
        );

        test(
          `SHELL='${shellName}' on ${system} with --add-to-path: appends the line to ~/${file} once`,
          async () => {
            const c = shCase(shellPath, { system, machine });
            const target = join(c.home, file);
            const before = "# my settings\nalias ll='ls -l'";
            if (!file.includes("/")) writeFileSync(target, before);
            const first = await c.run(
              ["--from", fromDir(platform), "--add-to-path"],
              {
                SHELL: shellName,
              },
            );
            expect(first.code).toBe(0);
            const second = await c.run(
              ["--from", fromDir(platform), "--add-to-path"],
              {
                SHELL: shellName,
              },
            );
            expect(second.code).toBe(0);
            const written = readText(target);
            const lines = written.split("\n");
            expect(lines.filter((l) => l === line)).toHaveLength(1);
            if (!file.includes("/"))
              expect(written.startsWith(`${before}\n`)).toBe(true);
            expect(first.stdout).toContain(line);
            expect(first.stdout).toMatch(/new terminal/i);
          },
          TIMEOUT_MS,
        );
      }

      test(
        "--add-to-path writes nothing when the install directory is already on PATH",
        async () => {
          const c = shCase(shellPath);
          const result = await c.run(
            ["--from", fromDir(), "--add-to-path"],
            { SHELL: "/bin/zsh" },
            pathWith(c.stubs, c.bin),
          );
          expect(result.code).toBe(0);
          expect(existsSync(join(c.home, ".zshrc"))).toBe(false);
        },
        TIMEOUT_MS,
      );
    });

    describe("where the token goes, and what a token may be", () => {
      const assets = releaseAssets("linux-x64", LINUX);

      function tokenOf(call: {
        stdin: string | undefined;
      }): string | undefined {
        return /Authorization: Bearer ([^"\s]+)/.exec(call.stdin ?? "")?.[1];
      }

      test(
        "assets on another origin than the API's get no token",
        async () => {
          const assetServer = startFakeGitHub({
            releases: [{ tag: "v0.3.0", assets }],
          });
          const server = startFakeGitHub({
            releases: [{ tag: "v0.3.0", assets }],
            latest: "v0.3.0",
            assetOrigin: assetServer.origin,
          });
          try {
            const c = shCase(shellPath);
            const result = await c.run(["--repo", server.api], {
              ETA_RELEASES_TOKEN: "tok-eta",
            });
            expect(result.stderr).toBe("");
            expect(result.code).toBe(0);
            expect(
              server.requests.map((r) => [r.path, r.authorization]),
            ).toEqual([["/repos/o/r/releases/latest", "Bearer tok-eta"]]);
            expect(assetServer.requests).toHaveLength(6);
            for (const request of assetServer.requests)
              expect(request.authorization).toBeNull();
            expect(readText(join(c.bin, "eta-host"))).toBe(LINUX.host);
          } finally {
            await server.stop();
            await assetServer.stop();
          }
        },
        TIMEOUT_MS,
      );

      test(
        "assets on the API's origin, with the host written in another case, still get the token",
        async () => {
          const server = startFakeGitHub({
            releases: [{ tag: "v0.3.0", assets }],
            latest: "v0.3.0",
          });
          try {
            const c = shCase(shellPath);
            const result = await c.run(
              ["--repo", server.api.replace("127.0.0.1", "LOCALHOST")],
              { ETA_RELEASES_TOKEN: "tok-eta" },
            );
            expect(result.code).toBe(0);
            const api = server.requests.filter((r) =>
              r.path.startsWith("/repos/"),
            );
            expect(api).toHaveLength(4);
            for (const request of api)
              expect(request.authorization).toBe("Bearer tok-eta");
          } finally {
            await server.stop();
          }
        },
        TIMEOUT_MS,
      );

      test(
        "every request starts curl with -q, the token is in no request's arguments, and it rides only on the API requests",
        async () => {
          const server = startFakeGitHub({
            releases: [{ tag: "v0.3.0", assets }],
            latest: "v0.3.0",
          });
          try {
            const c = shCase(shellPath);
            curlProxy(c.stubs, c.curlLog);
            const result = await c.run(["--repo", server.api], {
              ETA_RELEASES_TOKEN: "tok-eta",
            });
            expect(result.code).toBe(0);
            const calls = readCurlCalls(c.curlLog);
            expect(calls).toHaveLength(7);
            for (const call of calls) {
              expect(call.args[0]).toBe("-q");
              for (const arg of call.args) expect(arg).not.toContain("tok-eta");
            }
            const withToken = calls.filter(
              (call) => tokenOf(call) === "tok-eta",
            );
            expect(withToken.map((call) => call.args.at(-1))).toEqual([
              `${server.api}/releases/latest`,
              ...["eta-linux-x64", "eta-host-linux-x64", "SHA256SUMS"].map(
                (name) => `${server.api}/releases/assets/v0.3.0/${name}`,
              ),
            ]);
            expect(
              calls.filter((call) => call.stdin === undefined),
            ).toHaveLength(3);
          } finally {
            await server.stop();
          }
        },
        TIMEOUT_MS,
      );

      test(
        "a release request that is redirected is followed without the token",
        async () => {
          const server = startFakeGitHub({
            releases: [{ tag: "v0.3.0", assets }],
            latest: "v0.3.0",
            redirectRelease: true,
          });
          try {
            const c = shCase(shellPath);
            const result = await c.run(
              ["--repo", server.api, "--version", "0.3.0"],
              {
                ETA_RELEASES_TOKEN: "tok-eta",
              },
            );
            expect(result.code).toBe(0);
            expect(
              server.requests.slice(0, 2).map((r) => [r.path, r.authorization]),
            ).toEqual([
              ["/repos/o/r/releases/tags/v0.3.0", "Bearer tok-eta"],
              ["/moved/repos/o/r/releases/tags/v0.3.0", null],
            ]);
          } finally {
            await server.stop();
          }
        },
        TIMEOUT_MS,
      );

      test(
        "a user's ~/.curlrc is not read",
        async () => {
          const server = startFakeGitHub({
            releases: [{ tag: "v0.3.0", assets }],
            latest: "v0.3.0",
          });
          try {
            const c = shCase(shellPath);
            writeFileSync(
              join(c.home, ".curlrc"),
              'header = "X-Curlrc: read"\n',
            );
            const result = await c.run(["--repo", server.api]);
            expect(result.code).toBe(0);
            expect(server.headers.length).toBeGreaterThan(0);
            for (const headers of server.headers)
              expect(headers.get("x-curlrc")).toBeNull();
          } finally {
            await server.stop();
          }
        },
        TIMEOUT_MS,
      );

      test(
        "a token is used without the white space around it",
        async () => {
          const server = startFakeGitHub({
            releases: [{ tag: "v0.3.0", assets }],
            latest: "v0.3.0",
          });
          try {
            const c = shCase(shellPath);
            const result = await c.run(["--repo", server.api], {
              ETA_RELEASES_TOKEN: " \ttok-eta\r\n",
            });
            expect(result.code).toBe(0);
            expect(server.requests[0]?.authorization).toBe("Bearer tok-eta");
          } finally {
            await server.stop();
          }
        },
        TIMEOUT_MS,
      );

      for (const [variable, repo] of [
        ["GH_TOKEN", "o/r"],
        ["GITHUB_TOKEN", "o/r"],
        ["ETA_RELEASES_TOKEN", "http://127.0.0.1:9/x/y"],
      ] as const) {
        for (const bad of [
          "tok bad",
          "tök-bad",
          'tok"bad',
          "tok\\bad",
          "tok\nbad",
        ]) {
          test(
            `a ${variable} of ${JSON.stringify(bad)} is refused, naming the variable and not the token`,
            async () => {
              const c = shCase(shellPath, { curlStatus: 200 });
              const result = await c.run(["--repo", repo], { [variable]: bad });
              expect(result.code).toBe(1);
              expect(result.stderr.startsWith("eta install: ")).toBe(true);
              expect(result.stderr).toContain(variable);
              expect(result.stderr).not.toContain("bad");
              expect(readCurlCalls(c.curlLog)).toEqual([]);
            },
            TIMEOUT_MS,
          );
        }
      }

      test(
        "a token from gh that is not printable ASCII is refused, naming gh",
        async () => {
          const c = shCase(shellPath, { curlStatus: 200, ghToken: "tok bad" });
          const result = await c.run(["--repo", "o/r"]);
          expect(result.code).toBe(1);
          expect(result.stderr).toContain("gh");
          expect(result.stderr).not.toContain("tok bad");
          expect(readCurlCalls(c.curlLog)).toEqual([]);
        },
        TIMEOUT_MS,
      );
    });

    describe("what the first round of review found untested", () => {
      test(
        "--force with an eta-host of the same --version leaves it as it is",
        async () => {
          const c = shCase(shellPath);
          const sameVersion = posixHost(
            "0.3.0",
            "another build of the same version",
          );
          writeFiles(c.bin, { "eta-host": sameVersion }, EXECUTABLE);
          const result = await c.run(["--from", fromDir(), "--force"]);
          expect(result.code).toBe(0);
          expect(readText(join(c.bin, "eta-host"))).toBe(sameVersion);
          expect(result.stdout).toContain("already");
          expect(result.stdout).toContain("left as it is");
          expect(`${result.stdout}${result.stderr}`).not.toMatch(
            /restart|replacing/i,
          );
        },
        TIMEOUT_MS,
      );

      test(
        "--from with a malformed --version is still a usage error",
        async () => {
          const c = shCase(shellPath);
          const result = await c.run(["--from", fromDir(), "--version", "0.3"]);
          expect(result.code).toBe(2);
          expect(entries(c.bin)).toEqual([]);
        },
        TIMEOUT_MS,
      );

      test(
        "--from ignores a well-formed --version",
        async () => {
          const c = shCase(shellPath);
          const result = await c.run([
            "--from",
            fromDir(),
            "--version",
            "9.9.9",
          ]);
          expect(result.code).toBe(0);
          expect(readText(join(c.bin, "eta-host"))).toBe(LINUX.host);
        },
        TIMEOUT_MS,
      );

      test(
        "an eta-host that prints its version on stderr is compared by that text",
        async () => {
          const c = shCase(shellPath);
          const onStderr = `#!/bin/sh\n[ "$1" = "--version" ] && echo "${versionLine("0.3.0")}" >&2\n`;
          writeFiles(c.bin, { "eta-host": onStderr }, EXECUTABLE);
          const result = await c.run(["--from", fromDir(), "--force"]);
          expect(result.code).toBe(0);
          expect(readText(join(c.bin, "eta-host"))).toBe(onStderr);
          expect(result.stdout).toContain("already");
          expect(result.stderr).toBe("");
        },
        TIMEOUT_MS,
      );

      test.skipIf(ON_WINDOWS)(
        "an eta-host without the execute bit counts as one that does not run (skipped on Windows: Git Bash runs a script by its #! line, whatever its mode)",
        async () => {
          const c = shCase(shellPath);
          const old = posixHost("0.3.0");
          writeFiles(c.bin, { "eta-host": old }, 0o644);
          const result = await c.run(["--from", fromDir()]);
          expect(result.code).toBe(0);
          expect(readText(join(c.bin, "eta-host"))).toBe(old);
          expect(result.stderr).toContain("does not run");
          expect(result.stderr).toContain("--force");
        },
        TIMEOUT_MS,
      );
    });

    describe("stopping half way", () => {
      /**
       * Ctrl+C reaches the installer's whole process group. Elsewhere this process sends it; a
       * signal from Bun on Windows ends a Git Bash process without running its traps, so there a
       * Git Bash with job control starts the installer in a group of its own and signals that.
       * That signal does not end curl, which is a native Windows program, so on Windows the
       * download then finishes, and the shell runs its trap when curl returns.
       */
      async function interrupted(
        c: ShCase,
        api: string,
        downloading: Promise<void>,
        finishDownload: () => void,
      ): Promise<number | null> {
        const env = cleanEnv({
          HOME: c.home,
          SHELL: "/bin/sh",
          PATH: pathWith(c.stubs),
        });
        if (ON_WINDOWS) {
          const go = join(tempDir("signal"), "go");
          const helper = join(tempDir("signal"), "interrupt.sh");
          writeFileSync(
            helper,
            `set -m
"$1" "$2" --repo "$3" &
pid=$!
while [ ! -e "$4" ]; do sleep 0.1; done
kill -INT -- -$pid
wait $pid
echo "code=$?"
`,
          );
          const slash = (path: string) => path.replaceAll("\\", "/");
          const finished = runToEnd(
            [
              SH ?? "sh",
              slash(helper),
              slash(shellPath),
              slash(SCRIPT),
              api,
              slash(go),
            ],
            { env, timeoutMs: TIMEOUT_MS },
          );
          await downloading;
          expect(entries(c.bin)).toHaveLength(1);
          writeFileSync(go, "");
          await Bun.sleep(1500);
          finishDownload();
          const result = await finished;
          const code = /code=(\d+)/.exec(result.stdout)?.[1];
          return code === undefined ? null : Number(code);
        }
        const { spawn } = await import("node:child_process");
        const child = spawn(shellPath, [SCRIPT, "--repo", api], {
          env,
          detached: true,
          stdio: "ignore",
        });
        const exited = new Promise<number | null>((resolve) =>
          child.on("exit", (code) => resolve(code)),
        );
        await downloading;
        expect(entries(c.bin)).toHaveLength(1);
        process.kill(-(child.pid as number), "SIGINT");
        return await exited;
      }

      test(
        "Ctrl+C during a download exits 130, removes the temporary directory and installs nothing",
        async () => {
          const assets = releaseAssets("linux-x64", LINUX);
          let reached: () => void = () => {};
          const downloading = new Promise<void>((resolve) => {
            reached = resolve;
          });
          let finishDownload: () => void = () => {};
          const server = startFakeGitHub({
            releases: [{ tag: "v0.3.0", assets }],
            latest: "v0.3.0",
            override: (path) => {
              if (
                !path.startsWith("/signed/") ||
                !path.endsWith("/eta-host-linux-x64")
              )
                return undefined;
              reached();
              // A body that goes on until the test ends it, as a slow download looks while it lasts.
              // Closed once: by the test, or by curl going away first.
              let open = true;
              return new Response(
                new ReadableStream({
                  start: (controller) => {
                    controller.enqueue(new TextEncoder().encode("partial"));
                    finishDownload = () => {
                      if (open) controller.close();
                      open = false;
                    };
                  },
                  cancel: () => {
                    open = false;
                  },
                }),
              );
            },
          });
          try {
            const c = shCase(shellPath);
            const code = await interrupted(c, server.api, downloading, () =>
              finishDownload(),
            );
            expect(code).toBe(130);
            expect(entries(c.bin)).toEqual([]);
          } finally {
            finishDownload();
            await server.stop();
          }
        },
        TIMEOUT_MS,
      );
    });
  });
}
