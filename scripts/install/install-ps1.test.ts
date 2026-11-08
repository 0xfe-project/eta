import type { Subprocess } from "bun";
import type { FakeGitHub, FakeGitHubOptions } from "./testing/fake-github";
import type { Finished } from "./testing/fixtures";
import type { ListedTag } from "./testing/latest-host-cases";
/**
 * `install.ps1` under PowerShell 7 (`pwsh`) and Windows PowerShell 5.1 (`powershell`).
 *
 * The whole flow runs only on Windows. A test runs the script as a file, as a script block, or
 * dot-sourced: dot-sourcing only defines its functions, so a test can call one alone, or put a
 * function of the same name in front of `Invoke-WebRequest` or `gh` to see what would be sent to
 * github.com. Requests to any other server go to a fake GitHub API in this process. The fake
 * eta-host is a real executable (`testing/windows-exe.ts`).
 *
 * No test writes the real `HKCU:\Environment` or broadcasts a change of environment: the
 * function that edits the user's Path is called on a key of its own under `HKCU:\Software`.
 */
import type { FakeHostVariant } from "./testing/windows-exe";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, test } from "bun:test";
import { startFakeGitHub } from "./testing/fake-github";
import {
  cleanEnv,
  pathWith,
  removeTempDirs,
  runToEnd,
  sha256,
  tempDir,
  versionLine,
  writeFiles,
} from "./testing/fixtures";
import { LATEST_HOST_CASES } from "./testing/latest-host-cases";
import { fakeHostExe } from "./testing/windows-exe";

const SCRIPT = join(import.meta.dir, "install.ps1");
const ON_WINDOWS = process.platform === "win32";
/** A PowerShell start is a second or two; an install moves a 100 MB executable more than once. */
const TIMEOUT_MS = 120_000;
const TUI_NAME = "eta-windows-x64.exe";
const HOST_NAME = "eta-host-windows-x64.exe";
/** The terminal interface is never run by the installer: any distinct bytes do. */
const TUI_BYTES = "eta terminal, windows build\n";

const held: Subprocess[] = [];
afterAll(() => {
  for (const child of held.splice(0)) child.kill();
  removeTempDirs();
});

const SHELLS = [
  { name: "pwsh", path: ON_WINDOWS ? Bun.which("pwsh") : null },
  { name: "powershell", path: ON_WINDOWS ? Bun.which("powershell") : null },
];

if (ON_WINDOWS && process.env.CI === "1") {
  for (const shell of SHELLS) {
    if (shell.path === null) {
      test(`${shell.name} is on PATH, which CI=1 requires on Windows`, () => {
        expect(shell.path).not.toBeNull();
      });
    }
  }
}

function psQuote(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/** A directory whose `gh` always fails, put in front of `PATH` so no test reaches a real login. */
function noGhDir(): string {
  const dir = tempDir("nogh");
  writeFileSync(join(dir, "gh.cmd"), "@echo no login 1>&2\r\n@exit /b 1\r\n");
  return dir;
}

interface PsCase {
  home: string;
  bin: string;
  /** Run `install.ps1` as a file. */
  run: (
    args: string[],
    env?: Record<string, string | undefined>,
    path?: string,
  ) => Promise<Finished>;
  /** Run `body` after dot-sourcing `install.ps1`, in the same session. */
  dot: (
    body: string,
    env?: Record<string, string | undefined>,
  ) => Promise<Finished>;
  /** Run `body` as a session command, without dot-sourcing anything. */
  command: (
    body: string,
    env?: Record<string, string | undefined>,
  ) => Promise<Finished>;
}

function psCase(ps: string): PsCase {
  const home = tempDir("home");
  const gh = noGhDir();
  const env = (
    extra: Record<string, string | undefined>,
    path = pathWith(gh),
  ) =>
    cleanEnv({
      USERPROFILE: home,
      HOME: home,
      OS: "Windows_NT",
      PROCESSOR_ARCHITECTURE: "AMD64",
      PROCESSOR_ARCHITEW6432: undefined,
      PATH: path,
      ...extra,
    });
  const base = [
    ps,
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
  ];
  const command = async (
    body: string,
    extra: Record<string, string | undefined> = {},
  ) =>
    await runToEnd([...base, "-Command", body], {
      env: env(extra),
      // Run in the test's home: a Windows PowerShell once wrote its ModuleAnalysisCache under
      // the working directory, which is the checkout otherwise.
      cwd: home,
      timeoutMs: TIMEOUT_MS,
    });
  return {
    home,
    bin: join(home, ".eta", "bin"),
    run: async (args, extra = {}, path) =>
      await runToEnd([...base, "-File", SCRIPT, ...args], {
        env: env(extra, path),
        cwd: home,
        timeoutMs: TIMEOUT_MS,
      }),
    dot: async (body, extra = {}) =>
      await command(
        `$ErrorActionPreference = 'Stop'\n. ${psQuote(SCRIPT)}\n${body}`,
        extra,
      ),
    command,
  };
}

/** The line a snippet printed after `JSON:`, parsed. */
function jsonFrom(result: Finished): unknown {
  const line = result.stdout.split(/\r?\n/).find((l) => l.startsWith("JSON:"));
  if (line === undefined)
    throw new Error(
      `no JSON line; stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  return JSON.parse(line.slice(5));
}

const hashes = new Map<string, string>();
function hashOf(path: string): string {
  let hash = hashes.get(path);
  if (hash === undefined) {
    hash = sha256(readFileSync(path));
    hashes.set(path, hash);
  }
  return hash;
}

function hashFile(path: string): string {
  return sha256(readFileSync(path));
}

/**
 * A `-From` directory with the fake eta-host `host` (a variant, or a path to any file), the
 * terminal interface's bytes, and `SHA256SUMS`, which `sums` replaces.
 */
async function fromDir(
  host: FakeHostVariant | string = { version: "0.3.0" },
  sums?: (correct: { tui: string; host: string }) => string,
  tui: string = TUI_BYTES,
): Promise<{ dir: string; hostPath: string }> {
  const hostPath = typeof host === "string" ? host : await fakeHostExe(host);
  const dir = tempDir("from");
  copyFileSync(hostPath, join(dir, HOST_NAME));
  writeFileSync(join(dir, TUI_NAME), tui);
  const correct = { tui: sha256(tui), host: hashOf(hostPath) };
  writeFileSync(
    join(dir, "SHA256SUMS"),
    sums?.(correct) ??
      `${correct.tui}  ${TUI_NAME}\n${correct.host}  ${HOST_NAME}\n`,
  );
  return { dir, hostPath };
}

/** Something named `.exe` that Windows will not run. */
function notAProgram(): string {
  const path = join(tempDir("junk"), "junk.exe");
  writeFileSync(path, "MZ this is not a program\n".repeat(64));
  return path;
}

function entries(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** Start `path --hold`, which keeps the file in use until the test ends. */
function hold(path: string): Subprocess {
  const child = Bun.spawn([path, "--hold"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  held.push(child);
  return child;
}

async function release(child: Subprocess): Promise<void> {
  child.kill();
  await child.exited;
}

/** PowerShell for a stand-in `Invoke-WebRequest` that records each call in `$global:Calls`. */
const RECORDING_IWR = `
class StubResponse { [int]$StatusCode }
class StubHttpError : System.Exception {
  [object]$Response
  StubHttpError([string]$message, [int]$status) : base($message) {
    $this.Response = [StubResponse]@{ StatusCode = $status }
  }
}
$global:Calls = @()
function Invoke-WebRequest {
  param($Uri, $Headers, $UserAgent, [switch]$UseBasicParsing, $OutFile,
    [Parameter(ValueFromRemainingArguments = $true)]$Rest)
  $global:Calls += [pscustomobject]@{
    Uri = "$Uri"
    Authorization = $Headers['Authorization']
    Accept = $Headers['Accept']
    UserAgent = $UserAgent
    Basic = [bool]$UseBasicParsing
    Progress = "$ProgressPreference"
    Tls12 = [bool]([Net.ServicePointManager]::SecurityProtocol -band [Net.SecurityProtocolType]::Tls12)
  }
  $status = if ("$Uri".EndsWith('/releases?per_page=100')) { $global:StubListStatus } else { $global:StubStatus }
  throw [StubHttpError]::new('Response status code does not indicate success', $status)
}
$global:StubStatus = 404
$global:StubListStatus = 404
`;

const PRINT_CALLS = `[Console]::Out.WriteLine('JSON:' + (ConvertTo-Json -Compress -InputObject @($global:Calls)))`;

/** The three files of a release whose eta-host is the plain 0.3.0 build. */
async function releaseServerAssets(): Promise<
  Record<string, Uint8Array | string>
> {
  const host = await fakeHostExe({ version: "0.3.0" });
  return {
    [TUI_NAME]: TUI_BYTES,
    [HOST_NAME]: readFileSync(host),
    SHA256SUMS: `${sha256(TUI_BYTES)}  ${TUI_NAME}\n${hashOf(host)}  ${HOST_NAME}\n`,
  };
}

interface StubCall {
  Uri: string;
  Authorization: string | null;
  Accept: string | null;
  UserAgent: string | null;
  Basic: boolean;
  Progress: string;
  Tls12: boolean;
}

for (const shell of SHELLS) {
  const reason = !ON_WINDOWS
    ? "skipped: not Windows"
    : shell.path === null
      ? `skipped: ${shell.name} is not on PATH`
      : "";
  const title = `install.ps1 under ${shell.name}${reason === "" ? "" : ` (${reason})`}`;
  const ps = shell.path ?? shell.name;

  describe.skipIf(reason !== "")(title, () => {
    /** Run the script dot-sourced, with `gh` printing `ghToken` (or failing), and the recording stand-in. */
    async function githubCalls(
      c: PsCase,
      args: string[],
      env: Record<string, string | undefined> = {},
      options: {
        ghToken?: string | null;
        status?: number;
        /** The status of the release list; `status` when not given. */
        listStatus?: number;
      } = {},
    ): Promise<{ calls: StubCall[]; code: number; result: Finished }> {
      const gh =
        options.ghToken === undefined || options.ghToken === null
          ? `function gh { $global:GhCalls += ,($args -join ' '); $global:LASTEXITCODE = 1 }`
          : `function gh { $global:GhCalls += ,($args -join ' '); if (($args -join ' ') -eq 'auth token --hostname github.com') { $global:LASTEXITCODE = 0; ${psQuote(options.ghToken)} } else { $global:LASTEXITCODE = 1 } }`;
      const result = await c.dot(
        `${RECORDING_IWR}
$global:StubStatus = ${options.status ?? 404}
$global:StubListStatus = ${options.listStatus ?? options.status ?? 404}
$global:GhCalls = @()
${gh}
$ProgressPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls11
$code = Start-EtaInstall -Arguments @(${args.map(psQuote).join(", ")})
[Console]::Out.WriteLine('CODE:' + $code)
[Console]::Out.WriteLine('GH:' + ($global:GhCalls -join '|'))
${PRINT_CALLS}`,
        env,
      );
      const code = Number(/CODE:(\d+)/.exec(result.stdout)?.[1] ?? Number.NaN);
      return { calls: jsonFrom(result) as StubCall[], code, result };
    }

    describe("the command line", () => {
      test(
        "-Help prints the usage to stdout and exits 0",
        async () => {
          const c = psCase(ps);
          const result = await c.run(["-Help"]);
          expect(result.code).toBe(0);
          expect(result.stderr).toBe("");
          for (const option of [
            "-Version",
            "-Repo",
            "-From",
            "-Force",
            "-AddToPath",
            "-Help",
          ])
            expect(result.stdout).toContain(option);
          expect(existsSync(c.bin)).toBe(false);
        },
        TIMEOUT_MS,
      );

      for (const args of [
        ["-Bogus"],
        ["extra"],
        ["-Version"],
        ["-Repo"],
        ["-From"],
        ["-Force", "-Version"],
      ]) {
        test(
          `${args.join(" ")} is a usage error: usage on stderr, exit 2`,
          async () => {
            const c = psCase(ps);
            const result = await c.run(args);
            expect(result.code).toBe(2);
            expect(result.stdout).toBe("");
            expect(result.stderr.startsWith("eta install: ")).toBe(true);
            expect(result.stderr).toContain("-AddToPath");
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
      ]) {
        test(
          `-Version '${version}' is a usage error`,
          async () => {
            const c = psCase(ps);
            const result = await c.run(["-Version", version]);
            expect(result.code).toBe(2);
            expect(result.stderr.startsWith("eta install: ")).toBe(true);
          },
          TIMEOUT_MS,
        );
      }

      test(
        "-Version 0.3.0, v0.3.0 and 0.3.0-rc.1 ask for their tags, and no -Version for the latest",
        async () => {
          const c = psCase(ps);
          const uris: string[] = [];
          for (const args of [
            ["-Version", "0.3.0"],
            ["-version", "v0.3.0"],
            ["-Version:", "0.3.0-rc.1"],
            [],
          ]) {
            const { calls } = await githubCalls(c, ["-Repo", "o/r", ...args]);
            uris.push(calls[0]?.Uri ?? "");
          }
          expect(uris).toEqual([
            "https://api.github.com/repos/o/r/releases/tags/v0.3.0",
            "https://api.github.com/repos/o/r/releases/tags/v0.3.0",
            "https://api.github.com/repos/o/r/releases/tags/v0.3.0-rc.1",
            "https://api.github.com/repos/o/r/releases/latest",
          ]);
        },
        TIMEOUT_MS,
      );
    });

    describe("the platform", () => {
      test(
        "anything but Windows is told to use install.sh",
        async () => {
          const c = psCase(ps);
          const { dir } = await fromDir();
          const result = await c.run(["-From", dir], { OS: "Linux" });
          expect(result.code).toBe(1);
          expect(result.stderr.startsWith("eta install: ")).toBe(true);
          expect(result.stderr).toContain("install.sh");
          expect(existsSync(join(c.bin, "eta-host.exe"))).toBe(false);
        },
        TIMEOUT_MS,
      );

      for (const [arch, w6432] of [
        ["ARM64", undefined],
        ["x86", undefined],
        ["AMD64", "ARM64"],
      ] as const) {
        test(
          `PROCESSOR_ARCHITECTURE=${arch}${w6432 === undefined ? "" : ` with PROCESSOR_ARCHITEW6432=${w6432}`} has no build`,
          async () => {
            const c = psCase(ps);
            const { dir } = await fromDir();
            const result = await c.run(["-From", dir], {
              PROCESSOR_ARCHITECTURE: arch,
              PROCESSOR_ARCHITEW6432: w6432,
            });
            expect(result.code).toBe(1);
            expect(result.stderr.startsWith("eta install: ")).toBe(true);
            expect(result.stderr).toContain("windows-x64");
            expect(existsSync(join(c.bin, "eta-host.exe"))).toBe(false);
          },
          TIMEOUT_MS,
        );
      }

      test(
        "a 32-bit PowerShell on 64-bit Windows (x86, PROCESSOR_ARCHITEW6432=AMD64) installs windows-x64",
        async () => {
          const c = psCase(ps);
          const { dir } = await fromDir();
          const result = await c.run(["-From", dir], {
            PROCESSOR_ARCHITECTURE: "x86",
            PROCESSOR_ARCHITEW6432: "AMD64",
          });
          expect(result.stderr).toBe("");
          expect(result.code).toBe(0);
        },
        TIMEOUT_MS,
      );
    });

    describe("-From, checking, and putting the files in place", () => {
      test(
        "a first install puts eta.exe and eta-host.exe in %USERPROFILE%\\.eta\\bin and says where",
        async () => {
          const c = psCase(ps);
          const { dir, hostPath } = await fromDir();
          const result = await c.run([
            "-From",
            dir,
            "-Repo",
            "https://user@nowhere/x?y",
          ]);
          expect(result.stderr).toBe("");
          expect(result.code).toBe(0);
          expect(entries(c.bin)).toEqual(["eta-host.exe", "eta.exe"]);
          expect(readFileSync(join(c.bin, "eta.exe"), "utf8")).toBe(TUI_BYTES);
          expect(hashFile(join(c.bin, "eta-host.exe"))).toBe(hashOf(hostPath));
          expect(result.stdout).toContain(join(c.bin, "eta.exe"));
          expect(result.stdout).toContain(join(c.bin, "eta-host.exe"));
          expect(result.stdout).toContain(versionLine("0.3.0"));
        },
        TIMEOUT_MS,
      );

      for (const missing of ["SHA256SUMS", TUI_NAME, HOST_NAME]) {
        test(
          `a directory without ${missing} is refused, naming it`,
          async () => {
            const c = psCase(ps);
            const { dir } = await fromDir();
            const { rmSync } = await import("node:fs");
            rmSync(join(dir, missing));
            const result = await c.run(["-From", dir]);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain(missing);
            expect(entries(c.bin)).toEqual([]);
          },
          TIMEOUT_MS,
        );
      }

      const OLD_TUI = "old terminal\n";

      async function installOld(c: PsCase): Promise<string> {
        const old = await fakeHostExe({ version: "0.2.0" });
        writeFiles(c.bin, {
          "eta.exe": OLD_TUI,
          "eta-host.exe.old": "left over",
        });
        copyFileSync(old, join(c.bin, "eta-host.exe"));
        return old;
      }

      function expectOldUntouched(c: PsCase, old: string): void {
        expect(entries(c.bin)).toEqual([
          "eta-host.exe",
          "eta-host.exe.old",
          "eta.exe",
        ]);
        expect(readFileSync(join(c.bin, "eta.exe"), "utf8")).toBe(OLD_TUI);
        expect(hashFile(join(c.bin, "eta-host.exe"))).toBe(hashOf(old));
      }

      test(
        "an eta-host that does not match SHA256SUMS is refused, naming it, and nothing is touched, not even a left-over .old",
        async () => {
          const c = psCase(ps);
          const old = await installOld(c);
          const { dir } = await fromDir(
            undefined,
            (s) => `${s.tui}  ${TUI_NAME}\n${"ab".repeat(32)}  ${HOST_NAME}\n`,
          );
          const result = await c.run(["-From", dir, "-Force"]);
          expect(result.code).toBe(1);
          expect(result.stderr).toContain(HOST_NAME);
          expectOldUntouched(c, old);
        },
        TIMEOUT_MS,
      );

      test(
        "eta without a line in SHA256SUMS is refused, naming it",
        async () => {
          const c = psCase(ps);
          const old = await installOld(c);
          const { dir } = await fromDir(
            undefined,
            (s) => `${s.host}  ${HOST_NAME}\n${s.tui}  dist/${TUI_NAME}\n`,
          );
          const result = await c.run(["-From", dir, "-Force"]);
          expect(result.code).toBe(1);
          expect(result.stderr).toContain(TUI_NAME);
          expectOldUntouched(c, old);
        },
        TIMEOUT_MS,
      );

      test(
        "takes '<hex> *<name>' and upper-case hex",
        async () => {
          const c = psCase(ps);
          const { dir } = await fromDir(
            undefined,
            (s) =>
              `${s.tui.toUpperCase()} *${TUI_NAME}\r\n${s.host} *${HOST_NAME}\r\n`,
          );
          const result = await c.run(["-From", dir]);
          expect(result.stderr).toBe("");
          expect(result.code).toBe(0);
        },
        TIMEOUT_MS,
      );

      test(
        "a downloaded eta-host that Windows cannot run is refused, and nothing is installed",
        async () => {
          const c = psCase(ps);
          const old = await installOld(c);
          const { dir } = await fromDir(notAProgram());
          const result = await c.run(["-From", dir, "-Force"]);
          expect(result.code).toBe(1);
          expect(result.stderr).toContain("does not run on this machine");
          expectOldUntouched(c, old);
        },
        TIMEOUT_MS,
      );

      test(
        "the files wait in a directory inside the install directory, which is gone afterwards; a left-over .old is removed",
        async () => {
          const c = psCase(ps);
          writeFiles(c.bin, {
            "eta.exe.old": "left over",
            "eta-host.exe.old": "left over",
          });
          const { dir } = await fromDir();
          const result = await c.run(["-From", dir]);
          expect(result.code).toBe(0);
          expect(entries(c.bin)).toEqual(["eta-host.exe", "eta.exe"]);
        },
        TIMEOUT_MS,
      );

      test(
        "an eta-host with the same --version is left as it is, and eta is replaced",
        async () => {
          const c = psCase(ps);
          // Prints the same version line as the plain 0.3.0 build, from different bytes.
          const same = await fakeHostExe({ version: "0.3.0", mode: "tamper" });
          writeFiles(c.bin, { "eta.exe": OLD_TUI });
          copyFileSync(same, join(c.bin, "eta-host.exe"));
          const { dir } = await fromDir();
          const result = await c.run(["-From", dir]);
          expect(result.code).toBe(0);
          expect(hashFile(join(c.bin, "eta-host.exe"))).toBe(hashOf(same));
          expect(readFileSync(join(c.bin, "eta.exe"), "utf8")).toBe(TUI_BYTES);
          expect(result.stdout).toContain("already");
          expect(result.stdout).toContain(versionLine("0.3.0"));
        },
        TIMEOUT_MS,
      );

      test(
        "an eta-host of another version is not replaced without -Force: exit 0, and stderr says how",
        async () => {
          const c = psCase(ps);
          const old = await fakeHostExe({ version: "0.2.0" });
          writeFiles(c.bin, {});
          copyFileSync(old, join(c.bin, "eta-host.exe"));
          const { dir } = await fromDir();
          const result = await c.run(["-From", dir]);
          expect(result.code).toBe(0);
          expect(hashFile(join(c.bin, "eta-host.exe"))).toBe(hashOf(old));
          expect(readFileSync(join(c.bin, "eta.exe"), "utf8")).toBe(TUI_BYTES);
          expect(result.stderr).toContain(versionLine("0.2.0"));
          expect(result.stderr).toContain(versionLine("0.3.0"));
          expect(result.stderr).toContain("eta-host upgrade");
          expect(result.stderr).toContain("-Force");
        },
        TIMEOUT_MS,
      );

      test(
        "an eta-host that does not run counts as another version",
        async () => {
          const c = psCase(ps);
          writeFiles(c.bin, {});
          copyFileSync(notAProgram(), join(c.bin, "eta-host.exe"));
          const before = hashFile(join(c.bin, "eta-host.exe"));
          const { dir } = await fromDir();
          const result = await c.run(["-From", dir]);
          expect(result.code).toBe(0);
          expect(hashFile(join(c.bin, "eta-host.exe"))).toBe(before);
          expect(result.stderr).toContain("-Force");
        },
        TIMEOUT_MS,
      );

      test(
        "-Force replaces an eta-host in use by renaming it to .old, then to .<random>.old, and says to restart",
        async () => {
          const c = psCase(ps);
          const v2 = await fakeHostExe({ version: "0.2.0" });
          const v3 = await fakeHostExe({ version: "0.3.0" });
          writeFiles(c.bin, {});
          copyFileSync(v2, join(c.bin, "eta-host.exe"));
          const first = hold(join(c.bin, "eta-host.exe"));
          await Bun.sleep(500);

          const to3 = await c.run([
            "-From",
            (await fromDir({ version: "0.3.0" })).dir,
            "-Force",
          ]);
          expect(to3.stderr).toBe("");
          expect(to3.code).toBe(0);
          expect(hashFile(join(c.bin, "eta-host.exe"))).toBe(hashOf(v3));
          expect(hashFile(join(c.bin, "eta-host.exe.old"))).toBe(hashOf(v2));
          expect(to3.stdout).toMatch(/restart/i);

          const second = hold(join(c.bin, "eta-host.exe"));
          await Bun.sleep(500);
          const to2 = await c.run([
            "-From",
            (await fromDir({ version: "0.2.0" })).dir,
            "-Force",
          ]);
          expect(to2.stderr).toBe("");
          expect(to2.code).toBe(0);
          expect(hashFile(join(c.bin, "eta-host.exe"))).toBe(hashOf(v2));
          const olds = entries(c.bin).filter((name) => name.endsWith(".old"));
          expect(olds).toContain("eta-host.exe.old");
          const random = olds.filter((name) =>
            /^eta-host\.exe\.[^.]+\.old$/.test(name),
          );
          expect(random).toHaveLength(1);
          expect(hashFile(join(c.bin, random[0] as string))).toBe(hashOf(v3));

          await release(first);
          await release(second);
          const again = await c.run([
            "-From",
            (await fromDir({ version: "0.2.0" })).dir,
          ]);
          expect(again.code).toBe(0);
          expect(entries(c.bin)).toEqual(["eta-host.exe", "eta.exe"]);
        },
        TIMEOUT_MS * 2,
      );

      test(
        "an eta.exe in use is replaced the same way",
        async () => {
          const c = psCase(ps);
          const running = await fakeHostExe({ version: "0.2.0" });
          writeFiles(c.bin, {});
          copyFileSync(running, join(c.bin, "eta.exe"));
          const child = hold(join(c.bin, "eta.exe"));
          await Bun.sleep(500);
          const result = await c.run(["-From", (await fromDir()).dir]);
          expect(result.code).toBe(0);
          expect(readFileSync(join(c.bin, "eta.exe"), "utf8")).toBe(TUI_BYTES);
          expect(hashFile(join(c.bin, "eta.exe.old"))).toBe(hashOf(running));
          await release(child);
        },
        TIMEOUT_MS,
      );
    });

    describe("downloading from a server", () => {
      async function serverAssets(): Promise<
        Record<string, Uint8Array | string>
      > {
        const host = await fakeHostExe({ version: "0.3.0" });
        const bytes = readFileSync(host);
        return {
          [TUI_NAME]: TUI_BYTES,
          [HOST_NAME]: bytes,
          SHA256SUMS: `${sha256(TUI_BYTES)}  ${TUI_NAME}\n${hashOf(host)}  ${HOST_NAME}\n`,
        };
      }

      test(
        "installs the release; Invoke-WebRequest drops the token on the redirect to the signed address",
        async () => {
          const assets = await serverAssets();
          const server = startFakeGitHub({
            releases: [{ tag: "v0.3.0", assets }],
            latest: "v0.3.0",
          });
          try {
            const c = psCase(ps);
            const result = await c.run(["-Repo", server.api], {
              ETA_RELEASES_TOKEN: "tok-eta",
              GH_TOKEN: "tok-ghtoken",
              GITHUB_TOKEN: "tok-github",
            });
            expect(result.stderr).toBe("");
            expect(result.code).toBe(0);
            expect(hashFile(join(c.bin, "eta-host.exe"))).toBe(
              sha256(assets[HOST_NAME] as Uint8Array),
            );
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
            expect(
              api
                .slice(1)
                .map((r) => r.path)
                .sort(),
            ).toEqual(
              Object.keys(assets)
                .map((n) => `/repos/o/r/releases/assets/v0.3.0/${n}`)
                .sort(),
            );
            for (const request of api.slice(1)) {
              expect(request.authorization).toBe("Bearer tok-eta");
              expect(request.accept).toBe("application/octet-stream");
              expect(request.userAgent).toBe("eta-install");
            }
            expect(signed).toHaveLength(3);
            for (const request of signed)
              expect(request.authorization).toBeNull();
            for (const request of server.requests) {
              expect(request.authorization ?? "").not.toContain("tok-ghtoken");
              expect(request.authorization ?? "").not.toContain("tok-github");
            }
          } finally {
            await server.stop();
          }
        },
        TIMEOUT_MS,
      );

      test(
        "a draft is refused",
        async () => {
          const server = startFakeGitHub({
            releases: [
              { tag: "v0.3.0", assets: await serverAssets(), draft: true },
            ],
            latest: "v0.3.0",
          });
          try {
            const c = psCase(ps);
            const result = await c.run(["-Repo", server.api]);
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
                  [HOST_NAME]: "x",
                  "ETA-WINDOWS-X64.EXE": "x",
                  "SHA256SUMS.old": "x",
                },
              },
            ],
            latest: "v0.3.0",
          });
          try {
            const c = psCase(ps);
            const result = await c.run(["-Repo", server.api]);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain(TUI_NAME);
            expect(result.stderr).toMatch(/SHA256SUMS(?!\.)/);
            expect(result.stderr).not.toContain(HOST_NAME);
          } finally {
            await server.stop();
          }
        },
        TIMEOUT_MS,
      );

      for (const status of [401, 403, 404]) {
        test(
          `${status} without a token on another server points at ETA_RELEASES_TOKEN only`,
          async () => {
            // A private server refuses the list as well: after a 404 for the latest release the
            // list is asked for, and its answer is the one reported.
            const server = startFakeGitHub({
              releases: [],
              override: (path) =>
                path.endsWith("/releases/latest") || path.endsWith("/releases")
                  ? new Response("no", { status })
                  : undefined,
            });
            try {
              const c = psCase(ps);
              const result = await c.run(["-Repo", server.api], {
                GH_TOKEN: "tok-ghtoken",
              });
              expect(result.code).toBe(1);
              expect(result.stderr).toContain(String(status));
              expect(result.stderr).toContain("ETA_RELEASES_TOKEN");
              expect(result.stderr).not.toContain("gh auth login");
              for (const request of server.requests)
                expect(request.authorization).toBeNull();
            } finally {
              await server.stop();
            }
          },
          TIMEOUT_MS,
        );
      }

      test(
        "a failed request gives its status, and not the token the server echoes",
        async () => {
          const server = startFakeGitHub({
            releases: [],
            override: (path, request) =>
              path.endsWith("/releases/latest")
                ? new Response(
                    `bad gateway for ${request.headers.get("authorization")}`,
                    { status: 502 },
                  )
                : undefined,
          });
          try {
            const c = psCase(ps);
            const result = await c.run(["-Repo", server.api], {
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
            releases: [{ tag: "v0.3.0", assets: await serverAssets() }],
            latest: "v0.3.0",
            override: (path) =>
              path.startsWith("/signed/") && path.endsWith(`/${HOST_NAME}`)
                ? new Response("unavailable", { status: 503 })
                : undefined,
          });
          try {
            const c = psCase(ps);
            const result = await c.run(["-Repo", server.api]);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain("503");
            expect(entries(c.bin)).toEqual([]);
          } finally {
            await server.stop();
          }
        },
        TIMEOUT_MS,
      );
    });

    describe("which release an install without -Version takes", () => {
      const LIST_URL = "/repos/o/r/releases?per_page=100";

      /** The terminal interface's bytes name the tag, so what was installed says where it came from. */
      function tuiOf(tag: string): string {
        return `eta terminal ${tag}\n`;
      }

      /** The plain 0.3.0 build, read once: a page of releases shares the same bytes. */
      let hostBytes: Uint8Array | undefined;

      /** Every release has the plain 0.3.0 eta-host; only the terminal interface tells them apart. */
      async function assetsOf(
        tag: string,
      ): Promise<Record<string, Uint8Array | string>> {
        const host = await fakeHostExe({ version: "0.3.0" });
        hostBytes ??= readFileSync(host);
        return {
          [TUI_NAME]: tuiOf(tag),
          [HOST_NAME]: hostBytes,
          SHA256SUMS: `${sha256(tuiOf(tag))}  ${TUI_NAME}\n${hashOf(host)}  ${HOST_NAME}\n`,
        };
      }

      async function serverFor(
        releases: ListedTag[],
        latest: string | undefined,
        extra: Partial<FakeGitHubOptions> = {},
      ): Promise<FakeGitHub> {
        const withAssets = await Promise.all(
          releases.map(async (release) => ({
            ...release,
            assets: await assetsOf(release.tag),
          })),
        );
        return startFakeGitHub({ releases: withAssets, latest, ...extra });
      }

      const OLD = { tui: "old terminal\n", host: "old host\n" };

      for (const row of LATEST_HOST_CASES) {
        test(
          `${row.name}: ${row.installs === null ? "fails" : `installs ${row.installs}`}`,
          async () => {
            const server = await serverFor(row.releases, row.latest);
            try {
              const c = psCase(ps);
              writeFiles(c.bin, {
                "eta.exe": OLD.tui,
                "eta-host.exe": OLD.host,
              });
              const result = await c.run(["-Repo", server.api, "-Force"]);
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
                expect(result.stderr).toContain("-Version");
                expect(
                  server.urls.filter(
                    (url) =>
                      url.includes("/releases/tags/") ||
                      url.includes("/releases/assets/") ||
                      url.startsWith("/signed/"),
                  ),
                ).toEqual([]);
                expect(entries(c.bin)).toEqual(["eta-host.exe", "eta.exe"]);
                expect(readFileSync(join(c.bin, "eta.exe"), "utf8")).toBe(
                  OLD.tui,
                );
                expect(readFileSync(join(c.bin, "eta-host.exe"), "utf8")).toBe(
                  OLD.host,
                );
                return;
              }
              expect(result.code, why).toBe(0);
              expect(result.stderr).toBe("");
              expect(readFileSync(join(c.bin, "eta.exe"), "utf8")).toBe(
                tuiOf(row.installs),
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
          const server = await serverFor([{ tag: "v0.3.0" }], undefined, {
            override: (path) =>
              path.endsWith("/releases/latest")
                ? new Response("boom", { status: 500 })
                : undefined,
          });
          try {
            const c = psCase(ps);
            const result = await c.run(["-Repo", server.api]);
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
            const server = await serverFor([{ tag: "v0.3.0" }], undefined, {
              override: (path) =>
                path.endsWith("/releases/latest")
                  ? new Response(answer, {
                      headers: { "content-type": "application/json" },
                    })
                  : undefined,
            });
            try {
              const c = psCase(ps);
              const result = await c.run(["-Repo", server.api]);
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
            const server = await serverFor([{ tag: "v0.3.0" }], undefined, {
              override: (path) =>
                path.endsWith("/releases")
                  ? new Response("no", { status })
                  : undefined,
            });
            try {
              const c = psCase(ps);
              const result = await c.run(["-Repo", server.api]);
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
            const c = psCase(ps);
            const run = await githubCalls(
              c,
              ["-Repo", "o/r"],
              {},
              { status: 404, listStatus: status },
            );
            expect(run.code).toBe(1);
            expect(run.result.stderr).toContain(String(status));
            expect(run.result.stderr).toContain("private");
            expect(run.result.stderr).toContain("gh auth login");
            expect(run.calls.map((call) => call.Uri)).toEqual([
              "https://api.github.com/repos/o/r/releases/latest",
              "https://api.github.com/repos/o/r/releases?per_page=100",
            ]);
          },
          TIMEOUT_MS,
        );
      }

      test(
        "on github.com the list gets the token too",
        async () => {
          const c = psCase(ps);
          const run = await githubCalls(
            c,
            ["-Repo", "o/r"],
            { GH_TOKEN: "tok-ghtoken" },
            { status: 404, listStatus: 403 },
          );
          expect(run.code).toBe(1);
          expect(
            run.calls.map((call) => [call.Uri, call.Authorization]),
          ).toEqual([
            [
              "https://api.github.com/repos/o/r/releases/latest",
              "Bearer tok-ghtoken",
            ],
            [
              "https://api.github.com/repos/o/r/releases?per_page=100",
              "Bearer tok-ghtoken",
            ],
          ]);
          expect(run.result.stderr).toContain("403");
          expect(run.result.stderr).not.toContain("tok-ghtoken");
          expect(run.result.stderr).not.toContain("gh auth login");
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
            const server = await serverFor([{ tag: "v0.3.0" }], undefined, {
              override: (path) =>
                path.endsWith("/releases")
                  ? new Response(answer, {
                      headers: { "content-type": "application/json" },
                    })
                  : undefined,
            });
            try {
              const c = psCase(ps);
              const result = await c.run(["-Repo", server.api]);
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
        "-Version still takes that tag, and a draft there is refused",
        async () => {
          const server = await serverFor(
            [{ tag: "v0.3.0", draft: true }, { tag: "v0.2.0" }],
            "v0.2.0",
          );
          try {
            const c = psCase(ps);
            const result = await c.run([
              "-Repo",
              server.api,
              "-Version",
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

    describe("which repository and which token", () => {
      test(
        "github.com gets GH_TOKEN, then GITHUB_TOKEN, then gh's token; never ETA_RELEASES_TOKEN",
        async () => {
          const c = psCase(ps);
          const all = await githubCalls(
            c,
            ["-Repo", "o/r"],
            {
              GH_TOKEN: "tok-ghtoken",
              GITHUB_TOKEN: "tok-github",
              ETA_RELEASES_TOKEN: "tok-eta",
            },
            { ghToken: "tok-gh" },
          );
          expect(all.calls[0]?.Authorization).toBe("Bearer tok-ghtoken");
          const second = await githubCalls(
            c,
            ["-Repo", "o/r"],
            { GITHUB_TOKEN: "tok-github", ETA_RELEASES_TOKEN: "tok-eta" },
            { ghToken: "tok-gh" },
          );
          expect(second.calls[0]?.Authorization).toBe("Bearer tok-github");
          const fromGh = await githubCalls(
            c,
            ["-Repo", "o/r"],
            { ETA_RELEASES_TOKEN: "tok-eta" },
            {
              ghToken: "tok-gh",
            },
          );
          expect(fromGh.calls[0]?.Authorization).toBe("Bearer tok-gh");
          expect(fromGh.result.stdout).toContain(
            "GH:auth token --hostname github.com",
          );
          const anonymous = await githubCalls(
            c,
            ["-Repo", "o/r"],
            { ETA_RELEASES_TOKEN: "tok-eta" },
            {
              ghToken: null,
            },
          );
          expect(anonymous.calls.length).toBeGreaterThan(0);
          expect(
            anonymous.calls.map((call) => call.Authorization ?? null),
          ).toEqual(anonymous.calls.map(() => null));
          for (const run of [all, second, fromGh, anonymous]) {
            for (const token of [
              "tok-ghtoken",
              "tok-github",
              "tok-gh",
              "tok-eta",
            ])
              expect(run.result.stderr).not.toContain(token);
          }
        },
        TIMEOUT_MS,
      );

      test(
        "the request is a basic-parsing GET with Accept and User-Agent, no progress bar, and TLS 1.2 on",
        async () => {
          const c = psCase(ps);
          const { calls } = await githubCalls(c, ["-Repo", "o/r"]);
          expect(calls[0]).toEqual({
            Uri: "https://api.github.com/repos/o/r/releases/latest",
            Authorization: null,
            Accept: "application/vnd.github+json",
            UserAgent: "eta-install",
            Basic: true,
            Progress: "SilentlyContinue",
            Tls12: true,
          });
        },
        TIMEOUT_MS,
      );

      test(
        "another server never gets GH_TOKEN, GITHUB_TOKEN or gh's token, and does get ETA_RELEASES_TOKEN",
        async () => {
          const c = psCase(ps);
          const without = await githubCalls(
            c,
            ["-Repo", "http://127.0.0.1:9/x/y/"],
            { GH_TOKEN: "tok-ghtoken", GITHUB_TOKEN: "tok-github" },
            { ghToken: "tok-gh" },
          );
          expect(without.calls[0]?.Uri).toBe(
            "http://127.0.0.1:9/x/y/releases/latest",
          );
          expect(without.calls[0]?.Authorization ?? null).toBeNull();
          expect(without.result.stdout).toMatch(/^GH:\r?$/m);
          const withToken = await githubCalls(
            c,
            ["-Repo", "http://127.0.0.1:9/x/y"],
            {
              GH_TOKEN: "tok-ghtoken",
              ETA_RELEASES_TOKEN: "tok-eta",
            },
          );
          expect(withToken.calls[0]?.Authorization).toBe("Bearer tok-eta");
        },
        TIMEOUT_MS,
      );

      test(
        "owner/name, github.com and api.github.com addresses, ETA_RELEASES_URL and the default name the same API",
        async () => {
          const c = psCase(ps);
          const uris: string[] = [];
          for (const args of [
            ["-Repo", "o/r"],
            ["-Repo", "https://github.com/o/r"],
            ["-Repo", "https://github.com/o/r/"],
            ["-Repo", "https://api.github.com/repos/o/r"],
          ]) {
            uris.push((await githubCalls(c, args)).calls[0]?.Uri ?? "");
          }
          uris.push(
            (await githubCalls(c, [], { ETA_RELEASES_URL: "env/repo" }))
              .calls[0]?.Uri ?? "",
          );
          uris.push(
            (
              await githubCalls(c, ["-Repo", "flag/repo"], {
                ETA_RELEASES_URL: "env/repo",
              })
            ).calls[0]?.Uri ?? "",
          );
          uris.push((await githubCalls(c, [])).calls[0]?.Uri ?? "");
          expect(uris).toEqual([
            ...Array.from<string>({ length: 4 }).fill(
              "https://api.github.com/repos/o/r/releases/latest",
            ),
            "https://api.github.com/repos/env/repo/releases/latest",
            "https://api.github.com/repos/flag/repo/releases/latest",
            "https://api.github.com/repos/0xfe-project/eta/releases/latest",
          ]);
        },
        TIMEOUT_MS,
      );

      test(
        "an address with a login or a query, or one it cannot read, is refused before any request",
        async () => {
          const c = psCase(ps);
          for (const given of [
            "https://user@github.com/o/r",
            "https://user:secret@example.com/releases",
            "https://example.com/releases?ref=x",
            "ftp://example.com/o/r",
            "o/r/extra",
            "just words",
          ]) {
            const run = await githubCalls(c, ["-Repo", given]);
            expect({ given, code: run.code, calls: run.calls.length }).toEqual({
              given,
              code: 1,
              calls: 0,
            });
            expect(run.result.stderr).toContain("eta install: ");
          }
        },
        TIMEOUT_MS,
      );

      for (const status of [401, 403, 404]) {
        test(
          `${status} without a token on github.com says the repository may be private, and how to log in`,
          async () => {
            const c = psCase(ps);
            const run = await githubCalls(c, ["-Repo", "o/r"], {}, { status });
            expect(run.code).toBe(1);
            expect(run.result.stderr).toContain(String(status));
            expect(run.result.stderr).toContain("private");
            expect(run.result.stderr).toContain("gh auth login");
            expect(run.result.stderr).toContain("GH_TOKEN");
            const withToken = await githubCalls(
              c,
              ["-Repo", "o/r"],
              { GH_TOKEN: "tok-ghtoken" },
              { status },
            );
            expect(withToken.result.stderr).toContain(String(status));
            expect(withToken.result.stderr).not.toContain("gh auth login");
            expect(withToken.result.stderr).not.toContain("tok-ghtoken");
          },
          TIMEOUT_MS,
        );
      }
    });

    describe("where the token goes, and what a token may be", () => {
      test(
        "assets on another origin than the API's get no token",
        async () => {
          const assets = await releaseServerAssets();
          const assetServer = startFakeGitHub({
            releases: [{ tag: "v0.3.0", assets }],
          });
          const server = startFakeGitHub({
            releases: [{ tag: "v0.3.0", assets }],
            latest: "v0.3.0",
            assetOrigin: assetServer.origin,
          });
          try {
            const c = psCase(ps);
            const result = await c.run(["-Repo", server.api], {
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
          } finally {
            await server.stop();
            await assetServer.stop();
          }
        },
        TIMEOUT_MS,
      );

      test(
        "a release request that is redirected is followed without the token, and the white space around a token is dropped",
        async () => {
          const server = startFakeGitHub({
            releases: [{ tag: "v0.3.0", assets: await releaseServerAssets() }],
            latest: "v0.3.0",
            redirectRelease: true,
          });
          try {
            const c = psCase(ps);
            const result = await c.run(["-Repo", server.api], {
              ETA_RELEASES_TOKEN: " \ttok-eta\r\n",
            });
            expect(result.stderr).toBe("");
            expect(result.code).toBe(0);
            expect(
              server.requests.slice(0, 2).map((r) => [r.path, r.authorization]),
            ).toEqual([
              ["/repos/o/r/releases/latest", "Bearer tok-eta"],
              ["/moved/repos/o/r/releases/latest", null],
            ]);
          } finally {
            await server.stop();
          }
        },
        TIMEOUT_MS,
      );

      for (const bad of ["tok bad", "tök-bad", "tok\nbad"]) {
        test(
          `a token of ${JSON.stringify(bad)} is refused, naming where it came from and not the token`,
          async () => {
            const c = psCase(ps);
            const runs = [
              [
                "GH_TOKEN",
                await githubCalls(c, ["-Repo", "o/r"], { GH_TOKEN: bad }),
              ],
              [
                "GITHUB_TOKEN",
                await githubCalls(c, ["-Repo", "o/r"], { GITHUB_TOKEN: bad }),
              ],
              [
                "ETA_RELEASES_TOKEN",
                await githubCalls(c, ["-Repo", "http://127.0.0.1:9/x/y"], {
                  ETA_RELEASES_TOKEN: bad,
                }),
              ],
              [
                "gh",
                await githubCalls(c, ["-Repo", "o/r"], {}, { ghToken: bad }),
              ],
            ] as const;
            for (const [source, run] of runs) {
              expect({
                source,
                code: run.code,
                calls: run.calls.length,
              }).toEqual({
                source,
                code: 1,
                calls: 0,
              });
              expect(run.result.stderr).toContain(
                `eta install: the token from ${source} `,
              );
              expect(run.result.stderr).not.toContain("bad");
            }
          },
          TIMEOUT_MS,
        );
      }

      test(
        "an error that holds a token shows [token] in its place",
        async () => {
          const c = psCase(ps);
          const result = await c.dot(
            `$token = Get-EtaToken ([pscustomobject]@{ Kind = 'github'; Label = 'o/r' })
Write-EtaError "before $token after"`,
            { GH_TOKEN: "tok-secret-1" },
          );
          expect(result.stderr).toBe(
            "eta install: before [token] after\r\n".replace(
              "\r",
              result.stderr.includes("\r") ? "\r" : "",
            ),
          );
        },
        TIMEOUT_MS,
      );
    });

    describe("what the first round of review found", () => {
      test(
        "a replacement that cannot move the new file in puts the old one back",
        async () => {
          const c = psCase(ps);
          const dir = tempDir("move");
          const result = await c.dot(`
$dir = ${psQuote(dir)}
$target = Join-Path $dir 'eta-host.exe'
$source = Join-Path $dir 'new.exe'
Set-Content -LiteralPath $target -Value 'old' -NoNewline
Set-Content -LiteralPath $source -Value 'new' -NoNewline
# Another process holding the new file this way keeps it from being moved.
$held = [IO.File]::Open($source, 'Open', 'Read', 'Read')
$failed = $false
try { Move-EtaIntoPlace $source $target } catch { $failed = $true }
$afterFailure = @{ failed = $failed; target = [IO.File]::ReadAllText($target); names = @(Get-ChildItem -LiteralPath $dir | ForEach-Object Name | Sort-Object) }
$held.Close()
Move-EtaIntoPlace $source $target
$afterSuccess = @{ target = [IO.File]::ReadAllText($target); names = @(Get-ChildItem -LiteralPath $dir | ForEach-Object Name | Sort-Object) }
[Console]::Out.WriteLine('JSON:' + (ConvertTo-Json -Compress -Depth 4 @{ afterFailure = $afterFailure; afterSuccess = $afterSuccess }))`);
          expect(jsonFrom(result)).toEqual({
            afterFailure: {
              failed: true,
              target: "old",
              names: ["eta-host.exe", "new.exe"],
            },
            afterSuccess: { target: "new", names: ["eta-host.exe"] },
          });
        },
        TIMEOUT_MS,
      );

      test(
        "after -AddToPath, run as a file it says to open a new terminal; as a script block it says this session has it",
        async () => {
          const c = psCase(ps);
          const stubs = `
function Add-UserPathEntry { param([string]$Directory, [string]$Key) return $true }
function Send-EnvironmentChange { }
function New-ItemProperty { throw 'the test would write the registry' }
function Set-ItemProperty { throw 'the test would write the registry' }`;
          const asFile = await c.dot(`${stubs}
$env:Path = 'C:\\Windows\\System32'
Update-EtaPath -Directory ${psQuote(c.bin)} -AddToPath $true -InSession $false`);
          expect(asFile.stdout).toMatch(/open a new terminal/i);
          expect(asFile.stdout).not.toMatch(/this session/i);
          const asBlock = await c.dot(`${stubs}
$env:Path = 'C:\\Windows\\System32'
Update-EtaPath -Directory ${psQuote(c.bin)} -AddToPath $true -InSession $true`);
          expect(asBlock.stdout).toMatch(/this session/i);
        },
        TIMEOUT_MS,
      );

      test(
        "Invoke-EtaInstall tells Update-EtaPath whether it runs from a file",
        async () => {
          const c = psCase(ps);
          const { dir } = await fromDir();
          const record = `function Update-EtaPath { param([string]$Directory, [bool]$AddToPath, [bool]$InSession) [Console]::Out.WriteLine('IN-SESSION:' + $InSession) }`;
          const fromFile = await c.dot(`${record}
Start-EtaInstall -Arguments @('-From', ${psQuote(dir)}) | Out-Null`);
          expect(fromFile.stdout).toContain("IN-SESSION:False");
          const fromBlock =
            await c.command(`. ([scriptblock]::Create((Get-Content -Raw -LiteralPath ${psQuote(SCRIPT)})))
${record}
Start-EtaInstall -Arguments @('-From', ${psQuote(dir)}) | Out-Null`);
          expect(fromBlock.stdout).toContain("IN-SESSION:True");
        },
        TIMEOUT_MS,
      );

      test(
        "the files wait in a directory inside the install directory, which is gone afterwards",
        async () => {
          const c = psCase(ps);
          const { dir } = await fromDir({ version: "0.3.0", mode: "record" });
          const result = await c.run(["-From", dir]);
          expect(result.code).toBe(0);
          const seen =
            readFileSync(join(c.home, "seen"), "utf8").split(/\r?\n/)[0] ?? "";
          expect(dirname(seen)).toBe(c.bin);
          expect(basename(seen)).toMatch(/^\.install\./);
          expect(existsSync(seen)).toBe(false);
        },
        TIMEOUT_MS,
      );

      test(
        "-Force with an eta-host of the same --version leaves it as it is",
        async () => {
          const c = psCase(ps);
          const same = await fakeHostExe({ version: "0.3.0", mode: "tamper" });
          writeFiles(c.bin, {});
          copyFileSync(same, join(c.bin, "eta-host.exe"));
          const result = await c.run([
            "-From",
            (await fromDir()).dir,
            "-Force",
          ]);
          expect(result.code).toBe(0);
          expect(hashFile(join(c.bin, "eta-host.exe"))).toBe(hashOf(same));
          expect(result.stdout).toContain("already");
          expect(result.stdout).toContain("left as it is");
          expect(`${result.stdout}${result.stderr}`).not.toMatch(
            /restart|replacing/i,
          );
        },
        TIMEOUT_MS,
      );

      test(
        "-From with a malformed -Version is a usage error, and a well-formed one is ignored",
        async () => {
          const c = psCase(ps);
          const { dir } = await fromDir();
          const malformed = await c.run(["-From", dir, "-Version", "0.3"]);
          expect(malformed.code).toBe(2);
          expect(entries(c.bin)).toEqual([]);
          const ignored = await c.run(["-From", dir, "-Version", "9.9.9"]);
          expect(ignored.code).toBe(0);
          expect(ignored.stdout).toContain(versionLine("0.3.0"));
        },
        TIMEOUT_MS,
      );

      test(
        "an eta-host that prints its version on stderr is compared by that text",
        async () => {
          const c = psCase(ps);
          const onStderr = await fakeHostExe({
            version: "0.3.0",
            mode: "stderr",
          });
          writeFiles(c.bin, {});
          copyFileSync(onStderr, join(c.bin, "eta-host.exe"));
          const result = await c.run([
            "-From",
            (await fromDir()).dir,
            "-Force",
          ]);
          expect(result.code).toBe(0);
          expect(hashFile(join(c.bin, "eta-host.exe"))).toBe(hashOf(onStderr));
          expect(result.stdout).toContain("already");
          expect(result.stderr).toBe("");
        },
        TIMEOUT_MS,
      );

      test(
        "stopping the pipeline during a download, as Ctrl+C does, removes the temporary directory",
        async () => {
          const go = join(tempDir("signal"), "go");
          let finish: () => void = () => {};
          const server = startFakeGitHub({
            releases: [{ tag: "v0.3.0", assets: await releaseServerAssets() }],
            latest: "v0.3.0",
            override: (path) => {
              if (
                !path.startsWith("/signed/") ||
                !path.endsWith(`/${HOST_NAME}`)
              )
                return undefined;
              writeFileSync(go, "");
              let open = true;
              // A download that keeps going, a kilobyte at a time: Windows PowerShell's
              // Invoke-WebRequest notices a stop only between reads, never in a stalled one.
              return new Response(
                new ReadableStream({
                  start: (controller) => {
                    const dribble = setInterval(() => {
                      if (open) controller.enqueue(new Uint8Array(1024));
                    }, 100);
                    finish = () => {
                      clearInterval(dribble);
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
            const c = psCase(ps);
            const result = await c.command(`
$ps = [powershell]::Create()
[void]$ps.AddScript(". ${psQuote(SCRIPT)}; Start-EtaInstall -Arguments @('-Repo', '${server.api}')")
$async = $ps.BeginInvoke()
$waited = 0
while (-not (Test-Path -LiteralPath ${psQuote(go)}) -and $waited -lt 600) { Start-Sleep -Milliseconds 100; $waited++ }
$stopping = $ps.BeginStop($null, $null)
$stopped = $stopping.AsyncWaitHandle.WaitOne(30000)
$left = @(Get-ChildItem -LiteralPath ${psQuote(c.bin)} -Force | ForEach-Object Name)
[Console]::Out.WriteLine('JSON:' + (ConvertTo-Json -Compress @{ reached = (Test-Path -LiteralPath ${psQuote(go)}); stopped = $stopped; state = $ps.InvocationStateInfo.State.ToString(); left = $left }))`);
            expect(jsonFrom(result)).toEqual({
              reached: true,
              stopped: true,
              state: "Stopped",
              left: [],
            });
          } finally {
            finish();
            await server.stop();
          }
        },
        TIMEOUT_MS,
      );
    });

    describe("how it is run", () => {
      test(
        "dot-sourcing only defines the functions",
        async () => {
          const c = psCase(ps);
          const result = await c.dot(
            `[Console]::Out.WriteLine('JSON:' + (ConvertTo-Json -Compress @((Get-Command Start-EtaInstall).CommandType.ToString(), (Get-Command Add-UserPathEntry).CommandType.ToString())))`,
          );
          expect(result.stderr).toBe("");
          expect(jsonFrom(result)).toEqual(["Function", "Function"]);
          expect(
            result.stdout.split(/\r?\n/).filter((l) => l !== ""),
          ).toHaveLength(1);
          expect(existsSync(c.bin)).toBe(false);
        },
        TIMEOUT_MS,
      );

      test(
        "as a script block it installs, and the session goes on with $LASTEXITCODE set",
        async () => {
          const c = psCase(ps);
          const { dir } = await fromDir();
          const missing = join(c.home, "no such directory");
          const block = `$block = [scriptblock]::Create((Get-Content -Raw -LiteralPath ${psQuote(SCRIPT)}))`;
          const result = await c.command(
            `${block}
& $block -From ${psQuote(dir)} -Force
[Console]::Out.WriteLine('AFTER-OK:' + $LASTEXITCODE)
& $block -From ${psQuote(missing)}
[Console]::Out.WriteLine('AFTER-FAIL:' + $LASTEXITCODE)
& $block -Bogus
[Console]::Out.WriteLine('AFTER-USAGE:' + $LASTEXITCODE)`,
          );
          expect(result.stdout).toContain("AFTER-OK:0");
          expect(result.stdout).toContain("AFTER-FAIL:1");
          expect(result.stdout).toContain("AFTER-USAGE:2");
          expect(result.code).toBe(0);
          expect(readFileSync(join(c.bin, "eta.exe"), "utf8")).toBe(TUI_BYTES);
          expect(result.stderr).toContain("eta install: ");
        },
        TIMEOUT_MS,
      );
    });

    describe("PATH", () => {
      async function userPath(c: PsCase): Promise<string> {
        const result = await c.command(
          `[Console]::Out.WriteLine('JSON:' + (ConvertTo-Json -Compress ([string](Get-Item 'HKCU:\\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames'))))`,
        );
        return jsonFrom(result) as string;
      }

      test(
        "says nothing about PATH when the install directory is on it, whatever its case or a trailing backslash",
        async () => {
          const c = psCase(ps);
          const { dir } = await fromDir();
          const entry = `${c.bin.toUpperCase()}\\`;
          const result = await c.run(["-From", dir], {}, pathWith(entry));
          expect(result.code).toBe(0);
          expect(result.stdout).not.toContain("-AddToPath");
          expect(result.stdout).not.toContain("PATH");
        },
        TIMEOUT_MS,
      );

      test(
        "an entry that only starts with the install directory does not count; it says to use -AddToPath and changes nothing",
        async () => {
          const c = psCase(ps);
          const before = await userPath(c);
          const { dir } = await fromDir();
          const result = await c.run(
            ["-From", dir],
            {},
            pathWith(`${c.bin}-old`),
          );
          expect(result.code).toBe(0);
          expect(result.stdout).toContain("-AddToPath");
          expect(await userPath(c)).toBe(before);
        },
        TIMEOUT_MS,
      );

      test(
        "-AddToPath edits the user's Path through Add-UserPathEntry, broadcasts once, and adds it to this session",
        async () => {
          const c = psCase(ps);
          const result = await c.dot(`
$global:Added = @(); $global:Broadcasts = 0
function Add-UserPathEntry { param([string]$Directory, [string]$Key) $global:Added += ,@($Directory, $Key, $PSBoundParameters.ContainsKey('Key')); return $true }
function Send-EnvironmentChange { $global:Broadcasts++ }
$env:Path = 'C:\\Windows\\System32'
Update-EtaPath -Directory ${psQuote(c.bin)} -AddToPath $true
$changed = @{ added = $global:Added; broadcasts = $global:Broadcasts; path = $env:Path }
$global:Added = @(); $global:Broadcasts = 0
function Add-UserPathEntry { param([string]$Directory, [string]$Key) $global:Added += ,@($Directory, $Key, $PSBoundParameters.ContainsKey('Key')); return $false }
$env:Path = 'C:\\Windows\\System32'
Update-EtaPath -Directory ${psQuote(c.bin)} -AddToPath $true
$unchanged = @{ added = $global:Added; broadcasts = $global:Broadcasts }
$global:Added = @(); $global:Broadcasts = 0
$env:Path = 'C:\\Windows\\System32;' + ${psQuote(c.bin)}
Update-EtaPath -Directory ${psQuote(c.bin)} -AddToPath $true
$onPath = @{ added = $global:Added.Count; broadcasts = $global:Broadcasts }
[Console]::Out.WriteLine('JSON:' + (ConvertTo-Json -Compress -Depth 5 @{ changed = $changed; unchanged = $unchanged; onPath = $onPath }))
`);
          expect(jsonFrom(result)).toEqual({
            changed: {
              added: [[c.bin, "", false]],
              broadcasts: 1,
              path: `C:\\Windows\\System32;${c.bin}`,
            },
            unchanged: { added: [[c.bin, "", false]], broadcasts: 0 },
            onPath: { added: 0, broadcasts: 0 },
          });
          expect(result.stdout).toMatch(/new terminal/i);
        },
        TIMEOUT_MS,
      );

      describe("Add-UserPathEntry, on a test key under HKCU:\\Software", () => {
        /** Run `body` with `$key` set to a new key, removed afterwards. */
        async function onTestKey(c: PsCase, body: string): Promise<unknown> {
          const result = await c.dot(
            `
$key = 'HKCU:\\Software\\eta-install-test-' + [Guid]::NewGuid().ToString('N')
New-Item -Path $key -Force | Out-Null
try {
${body}
} finally {
  Remove-Item -LiteralPath $key -Recurse -Force
}`,
            { ETA_TEST_VAR: "C:\\expanded", ETA_TEST_HOME: c.home },
          );
          return jsonFrom(result);
        }

        const READ = `$item = Get-Item -LiteralPath $key
$value = [pscustomobject]@{ changed = $changed; raw = $item.GetValue('Path', $null, 'DoNotExpandEnvironmentNames'); kind = $item.GetValueKind('Path').ToString() }
[Console]::Out.WriteLine('JSON:' + (ConvertTo-Json -Compress $value))`;

        test(
          "with no Path value it writes one of type ExpandString",
          async () => {
            const c = psCase(ps);
            expect(
              await onTestKey(
                c,
                `$changed = Add-UserPathEntry -Directory ${psQuote(c.bin)} -Key $key\n${READ}`,
              ),
            ).toEqual({ changed: true, raw: c.bin, kind: "ExpandString" });
          },
          TIMEOUT_MS,
        );

        test(
          "appends to a String value and keeps it a String, %VAR% unexpanded",
          async () => {
            const c = psCase(ps);
            expect(
              await onTestKey(
                c,
                `New-ItemProperty -LiteralPath $key -Name Path -Value 'C:\\a;%ETA_TEST_VAR%\\b' -PropertyType String | Out-Null
$changed = Add-UserPathEntry -Directory ${psQuote(c.bin)} -Key $key
${READ}`,
              ),
            ).toEqual({
              changed: true,
              raw: `C:\\a;%ETA_TEST_VAR%\\b;${c.bin}`,
              kind: "String",
            });
          },
          TIMEOUT_MS,
        );

        test(
          "appends to an ExpandString value ending in ';' without an empty entry",
          async () => {
            const c = psCase(ps);
            expect(
              await onTestKey(
                c,
                `New-ItemProperty -LiteralPath $key -Name Path -Value '%ETA_TEST_VAR%\\bin;' -PropertyType ExpandString | Out-Null
$changed = Add-UserPathEntry -Directory ${psQuote(c.bin)} -Key $key
${READ}`,
              ),
            ).toEqual({
              changed: true,
              raw: `%ETA_TEST_VAR%\\bin;${c.bin}`,
              kind: "ExpandString",
            });
          },
          TIMEOUT_MS,
        );

        test(
          "leaves a value that has the directory, in another case, with a trailing backslash, or as %VAR%",
          async () => {
            const c = psCase(ps);
            for (const entry of [
              `${c.bin.toUpperCase()}\\`,
              "%ETA_TEST_HOME%\\.eta\\bin",
            ]) {
              const raw = `C:\\a;${entry};C:\\b`;
              expect(
                await onTestKey(
                  c,
                  `New-ItemProperty -LiteralPath $key -Name Path -Value ${psQuote(raw)} -PropertyType ExpandString | Out-Null
$changed = Add-UserPathEntry -Directory ${psQuote(c.bin)} -Key $key
${READ}`,
                ),
              ).toEqual({ changed: false, raw, kind: "ExpandString" });
            }
          },
          TIMEOUT_MS,
        );

        test(
          "its -Key is HKCU:\\Environment unless given",
          async () => {
            const c = psCase(ps);
            const result = await c.dot(
              `$p = (Get-Command Add-UserPathEntry).ScriptBlock.Ast.Body.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'Key' }
[Console]::Out.WriteLine('JSON:' + (ConvertTo-Json -Compress $p.DefaultValue.Value))`,
            );
            expect(jsonFrom(result)).toBe("HKCU:\\Environment");
          },
          TIMEOUT_MS,
        );
      });
    });
  });
}
