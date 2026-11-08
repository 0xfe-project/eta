/**
 * Programs put in front of `PATH` for `install.sh`: they decide the platform it sees, stand in
 * for `gh`, record what `curl` was asked, and build a `PATH` that lacks a chosen tool.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { whichPosix } from "./fixtures";

/** A path as a POSIX shell on this machine takes it: Git Bash reads `C:/x` and not `C:\x`. */
function forShell(path: string): string {
  return path.replaceAll("\\", "/");
}

/** Single-quoted for `sh`. */
function quoted(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

function writeStub(dir: string, name: string, script: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `#!/bin/sh\n${script}`, { mode: 0o755 });
}

/** `uname -s` and `uname -m` answer `system` and `machine`. */
export function unameStub(dir: string, system: string, machine: string): void {
  writeStub(
    dir,
    "uname",
    `case "$1" in\n  -s) echo ${quoted(system)} ;;\n  -m) echo ${quoted(machine)} ;;\n  *) exit 1 ;;\nesac\n`,
  );
}

/** `sysctl -n hw.optional.arm64` answers `answer`; `null` makes it fail as on an Intel Mac. */
export function sysctlStub(dir: string, answer: string | null): void {
  writeStub(
    dir,
    "sysctl",
    answer === null
      ? `echo "sysctl: unknown oid" >&2\nexit 1\n`
      : `[ "$*" = "-n hw.optional.arm64" ] || exit 1\necho ${quoted(answer)}\n`,
  );
}

/**
 * `gh auth token --hostname github.com` prints `token`; anything else, or a `null` token, fails.
 * Each call is appended to `log`.
 */
export function ghStub(dir: string, token: string | null, log: string): void {
  const answer =
    token === null
      ? `echo "no oauth token found for github.com" >&2\nexit 1\n`
      : `if [ "$*" = "auth token --hostname github.com" ]; then echo ${quoted(token)}; exit 0; fi\nexit 1\n`;
  writeStub(
    dir,
    "gh",
    `printf 'gh %s\\n' "$*" >> ${quoted(forShell(log))}\n${answer}`,
  );
}

/**
 * A `curl` that answers every request with `status` and an empty body, and appends to `log`
 * each argument on a line of its own, then what it read from standard input when given
 * `--config -` (or `-K -`). With `listStatus`, a request for the release list
 * (`.../releases?per_page=100`) is answered with that instead.
 */
export function curlRecorder(
  dir: string,
  log: string,
  status: number,
  listStatus: number = status,
): void {
  const out = quoted(forShell(log));
  writeStub(
    dir,
    "curl",
    `printf 'CALL\\n' >> ${out}
for arg in "$@"; do printf 'ARG %s\\n' "$arg" >> ${out}; done
body= headers= write= config= url= previous=
for arg in "$@"; do
  case "$previous" in
    --url) url=$arg ;;
    -o|--output) body=$arg ;;
    -D|--dump-header) headers=$arg ;;
    -w|--write-out) write=1 ;;
    -K|--config) [ "$arg" = "-" ] && config=1 ;;
  esac
  previous=$arg
done
if [ -n "$config" ]; then printf 'STDIN\\n' >> ${out}; cat >> ${out}; printf '\\nEND\\n' >> ${out}; fi
status=${status}
case "$url" in *'/releases?per_page=100') status=${listStatus} ;; esac
[ -n "$body" ] && : > "$body"
[ -n "$headers" ] && printf 'HTTP/1.1 %s Stub\\r\\n\\r\\n' "$status" > "$headers"
[ -n "$write" ] && printf '%s' "$status"
exit 0
`,
  );
}

/**
 * A `curl` that appends to `log` what `curlRecorder` does, then runs the real curl with the
 * same arguments and standard input, so a whole download is recorded request by request.
 */
export function curlProxy(dir: string, log: string): void {
  const real = whichPosix("curl");
  if (real === null) throw new Error("curl is not on PATH");
  const out = quoted(forShell(log));
  const stdin = quoted(forShell(`${log}.stdin`));
  writeStub(
    dir,
    "curl",
    `printf 'CALL\\n' >> ${out}
for arg in "$@"; do printf 'ARG %s\\n' "$arg" >> ${out}; done
config= previous=
for arg in "$@"; do
  case "$previous" in -K|--config) [ "$arg" = "-" ] && config=1 ;; esac
  previous=$arg
done
if [ -n "$config" ]; then
  cat > ${stdin}
  { printf 'STDIN\\n'; cat ${stdin}; printf '\\nEND\\n'; } >> ${out}
  exec ${quoted(forShell(real))} "$@" < ${stdin}
fi
exec ${quoted(forShell(real))} "$@"
`,
  );
}

export interface CurlCall {
  args: string[];
  /** What it read as its config, or `undefined` when it read none. */
  stdin: string | undefined;
}

export function readCurlCalls(log: string): CurlCall[] {
  if (!existsSync(log)) return [];
  const calls: CurlCall[] = [];
  let stdin: string[] | undefined;
  for (const line of readFileSync(log, "utf8").split("\n")) {
    const current = calls.at(-1);
    if (stdin !== undefined && current !== undefined) {
      if (line === "END") {
        current.stdin = stdin.join("\n");
        stdin = undefined;
      } else {
        stdin.push(line);
      }
    } else if (line === "CALL") {
      calls.push({ args: [], stdin: undefined });
    } else if (line.startsWith("ARG ") && current !== undefined) {
      current.args.push(line.slice(4));
    } else if (line === "STDIN") {
      stdin = [];
    }
  }
  return calls;
}

/** What `install.sh` runs besides the tools a test takes away or stands in for. */
export const BASE_TOOLS = [
  "awk",
  "cat",
  "chmod",
  "cp",
  "mkdir",
  "mktemp",
  "mv",
  "rm",
];

/**
 * A directory to be the whole `PATH`: a wrapper for each of `tools` that runs the real one.
 * What it leaves out is missing for the script, which plain `PATH` order cannot arrange: on
 * Linux `curl` lives in `/usr/bin` with everything else.
 */
export function toolDir(dir: string, tools: string[]): void {
  for (const tool of tools) {
    const real = whichPosix(tool);
    if (real === null) throw new Error(`${tool} is not on PATH`);
    writeStub(dir, tool, `exec ${quoted(forShell(real))} "$@"\n`);
  }
}

/** The real `sha256sum`, for stand-ins of the other two hash tools to compute with. */
function realSha256sum(): string {
  const real = whichPosix("sha256sum");
  if (real === null) throw new Error("sha256sum is not on PATH");
  return quoted(forShell(real));
}

/** `shasum -a 256 [file]`, printed as shasum prints it; any other use fails. */
export function shasumStub(dir: string): void {
  writeStub(
    dir,
    "shasum",
    `[ "$1 $2" = "-a 256" ] && [ $# -le 3 ] || { echo "shasum stub: unexpected $*" >&2; exit 2; }
shift 2
if [ $# -eq 1 ]; then name=$1; hex=$(${realSha256sum()} < "$1" | { read -r h _; echo "$h"; })
else name=-; hex=$(${realSha256sum()} | { read -r h _; echo "$h"; }); fi
echo "$hex  $name"
`,
  );
}

/** `openssl dgst -sha256 [file]`, printed as OpenSSL 3 prints it; any other use fails. */
export function opensslStub(dir: string): void {
  writeStub(
    dir,
    "openssl",
    `[ "$1 $2" = "dgst -sha256" ] && [ $# -le 3 ] || { echo "openssl stub: unexpected $*" >&2; exit 2; }
shift 2
if [ $# -eq 1 ]; then name=$1; hex=$(${realSha256sum()} < "$1" | { read -r h _; echo "$h"; })
else name=stdin; hex=$(${realSha256sum()} | { read -r h _; echo "$h"; }); fi
echo "SHA2-256($name)= $hex"
`,
  );
}
