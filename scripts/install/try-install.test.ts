/**
 * `try-install.ts` run as a program on this machine, over fake builds: on Windows the fake
 * eta-host is a compiled executable, elsewhere a shell script.
 */
import type { FakeHostMode } from "./testing/windows-exe";
import { copyFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, test } from "bun:test";
import {
  cleanEnv,
  pathWith,
  posixHost,
  removeTempDirs,
  runToEnd,
  tempDir,
  versionLine,
  whichPosix,
} from "./testing/fixtures";
import { fakeHostExe } from "./testing/windows-exe";

const SCRIPT = join(import.meta.dir, "try-install.ts");
const ON_WINDOWS = process.platform === "win32";
const TIMEOUT_MS = 180_000;

afterAll(removeTempDirs);

const PLATFORM = (
  {
    "linux-x64": "linux-x64",
    "darwin-arm64": "darwin-arm64",
    "win32-x64": "windows-x64",
  } as Record<string, string | undefined>
)[`${process.platform}-${process.arch}`];
const EXE = ON_WINDOWS ? ".exe" : "";
const INSTALLER = ON_WINDOWS ? Bun.which("powershell") : whichPosix("sh");
const INSTALLER_NAME = ON_WINDOWS ? "powershell" : "sh";

if (INSTALLER === null && process.env.CI === "1") {
  test(`${INSTALLER_NAME} is on PATH, which CI=1 requires`, () => {
    expect(INSTALLER).not.toBeNull();
  });
}

/** A POSIX fake eta-host for each mode `windows-exe.ts` builds on Windows. */
function posixFake(mode: FakeHostMode): string {
  if (mode === "tamper")
    return `#!/bin/sh\nfor f in "\${0%/*}"/eta-*; do case \${f##*/} in eta-host*) ;; *) printf x >> "$f" ;; esac; done\necho "${versionLine("0.3.0")}"\n`;
  if (mode === "location")
    return `#!/bin/sh\ncase $0 in */.eta/*) echo "eta-host 0.3.0-moved (37d8188c1234)" ;; *) echo "${versionLine("0.3.0")}" ;; esac\n`;
  return posixHost("0.3.0");
}

/** A directory of builds as the release workflow has them, with the fake eta-host in `mode`. */
async function builds(mode: FakeHostMode): Promise<string> {
  const dir = tempDir("builds");
  writeFileSync(join(dir, `eta-${PLATFORM}${EXE}`), "eta terminal build\n");
  const host = join(dir, `eta-host-${PLATFORM}${EXE}`);
  if (ON_WINDOWS)
    copyFileSync(await fakeHostExe({ version: "0.3.0", mode }), host);
  else writeFileSync(host, posixFake(mode));
  return dir;
}

/** Run try-install.ts with its temporary directories in a directory of their own. */
async function tryInstall(args: string[]) {
  const temp = tempDir("tmp");
  const result = await runToEnd([process.execPath, SCRIPT, ...args], {
    env: cleanEnv({ TMPDIR: temp, TEMP: temp, TMP: temp, PATH: pathWith() }),
    timeoutMs: TIMEOUT_MS,
  });
  return { ...result, leftovers: readdirSync(temp) };
}

/** What a stand-in install script does after it puts eta in place. */
type FakeInstaller =
  /** Leaves eta-host out. */
  | "eta only"
  /** Installs eta-host with a byte more than the build. */
  | "longer host"
  /** Exits 3 having installed both. */
  | "exits 3"
  /** Installs both without the execute bit (POSIX). */
  | "not executable";

/** The stand-in for this platform's install script, run as `-From <dir>` or `--from <dir>`. */
function fakeInstaller(kind: FakeInstaller): string {
  if (ON_WINDOWS) {
    const host =
      kind === "eta only"
        ? ""
        : `Copy-Item -LiteralPath (Join-Path $from 'eta-host-${PLATFORM}.exe') -Destination (Join-Path $bin 'eta-host.exe')`;
    const after =
      kind === "longer host"
        ? `Add-Content -LiteralPath (Join-Path $bin 'eta-host.exe') -Value 'x' -NoNewline`
        : "";
    return `$from = $args[1]
$bin = Join-Path $env:USERPROFILE '.eta\\bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
Copy-Item -LiteralPath (Join-Path $from 'eta-${PLATFORM}.exe') -Destination (Join-Path $bin 'eta.exe')
${host}
${after}
exit ${kind === "exits 3" ? 3 : 0}
`;
  }
  const host =
    kind === "eta only" ? "" : `cp "$2/eta-host-${PLATFORM}" "$bin/eta-host"`;
  const after =
    kind === "longer host"
      ? `printf x >> "$bin/eta-host"`
      : kind === "not executable"
        ? `chmod 644 "$bin/eta" "$bin/eta-host"`
        : `chmod 755 "$bin"/*`;
  return `bin=$HOME/.eta/bin
mkdir -p "$bin"
cp "$2/eta-${PLATFORM}" "$bin/eta"
${host}
${after}
exit ${kind === "exits 3" ? 3 : 0}
`;
}

/**
 * Run a copy of try-install.ts that sits beside a stand-in install script, which is how it finds
 * the real one: this checks try-install's checks against install scripts that get it wrong.
 */
async function tryInstallWith(kind: FakeInstaller) {
  const dir = tempDir("try-install-copy");
  copyFileSync(SCRIPT, join(dir, "try-install.ts"));
  writeFileSync(
    join(dir, ON_WINDOWS ? "install.ps1" : "install.sh"),
    fakeInstaller(kind),
  );
  const temp = tempDir("tmp");
  const result = await runToEnd(
    [process.execPath, join(dir, "try-install.ts"), await builds("plain")],
    {
      env: cleanEnv({ TMPDIR: temp, TEMP: temp, TMP: temp, PATH: pathWith() }),
      timeoutMs: TIMEOUT_MS,
    },
  );
  return { ...result, leftovers: readdirSync(temp) };
}

const reason =
  PLATFORM === undefined
    ? ` (skipped: no build for ${process.platform}-${process.arch})`
    : INSTALLER === null
      ? ` (skipped: ${INSTALLER_NAME} is not on PATH)`
      : "";

describe.skipIf(reason !== "")(`try-install.ts on ${PLATFORM}${reason}`, () => {
  test(
    "a build the install script installs faithfully passes, with one line, and leaves no temporary directory",
    async () => {
      const result = await tryInstall([await builds("plain")]);
      expect(result.stdout).not.toContain("::error::");
      expect(result.code).toBe(0);
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(result.stdout).toContain(versionLine("0.3.0"));
      expect(result.leftovers).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "an installed eta that is one byte longer than the build fails as an annotation",
    async () => {
      const result = await tryInstall([await builds("tamper")]);
      expect(result.code).toBe(1);
      expect(result.stdout).toMatch(
        new RegExp(
          `^::error::.*eta${EXE.replace(".", "\\.")} is not the same bytes`,
          "m",
        ),
      );
      expect(result.leftovers).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "an installed eta-host whose --version differs from the build's fails as an annotation",
    async () => {
      const result = await tryInstall([await builds("location")]);
      expect(result.code).toBe(1);
      expect(result.stdout).toMatch(/^::error::.*--version.*0\.3\.0-moved/m);
      expect(result.leftovers).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "a directory without the eta-host build fails as an annotation naming it",
    async () => {
      const dir = tempDir("builds");
      writeFileSync(join(dir, `eta-${PLATFORM}${EXE}`), "eta terminal build\n");
      const result = await tryInstall([dir]);
      expect(result.code).toBe(1);
      expect(result.stdout).toMatch(
        new RegExp(`^::error::.*eta-host-${PLATFORM}`, "m"),
      );
    },
    TIMEOUT_MS,
  );

  test(
    "an install script that leaves eta-host out fails as an annotation",
    async () => {
      const result = await tryInstallWith("eta only");
      expect(result.code).toBe(1);
      expect(result.stdout).toMatch(
        new RegExp(
          `^::error::.*eta-host${EXE.replace(".", "\\.")} was not installed`,
          "m",
        ),
      );
      expect(result.leftovers).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "an installed eta-host that is one byte longer than the build fails as an annotation",
    async () => {
      const result = await tryInstallWith("longer host");
      expect(result.code).toBe(1);
      expect(result.stdout).toMatch(
        new RegExp(
          `^::error::.*eta-host${EXE.replace(".", "\\.")} is not the same bytes`,
          "m",
        ),
      );
    },
    TIMEOUT_MS,
  );

  test(
    "an install script that exits non-zero fails as an annotation, whatever it installed",
    async () => {
      const result = await tryInstallWith("exits 3");
      expect(result.code).toBe(1);
      expect(result.stdout).toMatch(
        /^::error::the install script exited with 3/m,
      );
    },
    TIMEOUT_MS,
  );

  test.skipIf(ON_WINDOWS)(
    "installed files without the execute bit fail as an annotation (skipped on Windows: there is no execute bit)",
    async () => {
      const result = await tryInstallWith("not executable");
      expect(result.code).toBe(1);
      expect(result.stdout).toMatch(/^::error::.*\/eta is not executable/m);
      expect(result.stdout).toMatch(
        /^::error::.*\/eta-host is not executable/m,
      );
    },
    TIMEOUT_MS,
  );

  test(
    "without a directory it prints the usage as an annotation",
    async () => {
      const result = await tryInstall([]);
      expect(result.code).toBe(1);
      expect(result.stdout).toMatch(/^::error::usage: /m);
    },
    TIMEOUT_MS,
  );
});
