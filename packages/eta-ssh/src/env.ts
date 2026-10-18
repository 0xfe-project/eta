/**
 * An ExecutionEnv on another machine.
 *
 * The filesystem and the shell here speak one protocol to the far side: a single
 * `sh` script per operation, whose stdout is the payload and whose exit code says
 * what went wrong (1 missing, 2 a directory where a file was wanted, 3 the other
 * way round, 4 not permitted). That is what makes the environment testable without
 * a server — the protocol is not SSH, it is shell, and any transport that runs a
 * script somewhere exercises it.
 *
 * Three decisions worth knowing about:
 *
 * - **Nothing is read into memory that was not asked for.** A text line reader
 *   pulls the remote file in fixed-size windows (`tail -c +N | head -c N`), so
 *   reading the first line of a gigabyte costs a window, not the file.
 * - **Binary is base64 on the wire.** `cat` over a shell is byte-safe in principle
 *   and fatal in practice (the transport decodes UTF-8 at the edges). Reads of
 *   binary go through `base64`, writes go in as stdin to `cat`, which is byte-exact.
 * - **Spill files land on the machine the commands run on**, so the agent's own
 *   `read` tool — which goes through this same environment — can open them.
 */
import { LiveOutput, OutputBuffer } from "@eta/execution/output";
import {
  type EnvCallOptions,
  type ExecutionEnv,
  ExecutionError,
  err,
  FileError,
  type FileInfo,
  ok,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type ShellOutputLimits,
  type TextLine,
  type TextLineReader,
} from "@eta/execution";
import {
  type SshResult,
  type SshRunOptions,
  type SshTransport,
  shellQuote,
} from "./transport";

/** The exit codes the scripts below use; each one maps to a stable error code. */
const EXIT_NOT_FOUND = 1;
const EXIT_IS_DIRECTORY = 2;
const EXIT_NOT_DIRECTORY = 3;
const EXIT_PERMISSION = 4;
/** A script ran and refused: the far side said why on stderr. */
const EXIT_UNKNOWN = 5;
/** How much of a text file one reader window pulls. */
const READER_WINDOW_BYTES = 256 * 1024;

export interface SshEnvironmentOptions {
  transport: SshTransport;
  /** Where relative paths start; defaults to the remote home directory. */
  cwd?: string | undefined;
  /** Diagnostics: a degraded path, a command that failed for an unclear reason. */
  warn?: ((message: string) => void) | undefined;
}

export class SshEnvironment implements ExecutionEnv {
  readonly cwd: string;
  private readonly transport: SshTransport;
  private readonly warn: (message: string) => void;

  constructor(options: SshEnvironmentOptions) {
    this.transport = options.transport;
    this.cwd = options.cwd ?? options.transport.home;
    this.warn = options.warn ?? (() => undefined);
  }

  // ----------------------------------------------------------------- paths

  async absolutePath(
    path: string,
    options: EnvCallOptions = {},
  ): Promise<Result<string, FileError>> {
    if (options.signal?.aborted === true) return err(aborted());
    return ok(resolvePath(this.cwd, path, this.transport.home));
  }

  async joinPath(
    parts: string[],
    options: EnvCallOptions = {},
  ): Promise<Result<string, FileError>> {
    if (options.signal?.aborted === true) return err(aborted());
    return ok(normalize(parts.join("/")));
  }

  // ----------------------------------------------------------------- reads

  async readTextFile(
    path: string,
    options: EnvCallOptions = {},
  ): Promise<Result<string, FileError>> {
    const absolute = this.absolute(path);
    const result = await this.script(
      `if [ -d ${quote(absolute)} ]; then exit ${EXIT_IS_DIRECTORY}; fi
if [ ! -e ${quote(absolute)} ]; then exit ${EXIT_NOT_FOUND}; fi
if [ ! -r ${quote(absolute)} ]; then exit ${EXIT_PERMISSION}; fi
cat -- ${quote(absolute)}`,
      options,
    );
    if (!result.ok) return result;
    return ok(result.value.stdout);
  }

  async readBinaryFile(
    path: string,
    options: EnvCallOptions = {},
  ): Promise<Result<Uint8Array, FileError>> {
    const absolute = this.absolute(path);
    const result = await this.script(
      `if [ -d ${quote(absolute)} ]; then exit ${EXIT_IS_DIRECTORY}; fi
if [ ! -e ${quote(absolute)} ]; then exit ${EXIT_NOT_FOUND}; fi
if [ ! -r ${quote(absolute)} ]; then exit ${EXIT_PERMISSION}; fi
base64 < ${quote(absolute)}`,
      options,
    );
    if (!result.ok) return result;
    const decoded = Buffer.from(
      result.value.stdout.replace(/\s+/g, ""),
      "base64",
    );
    return ok(new Uint8Array(decoded));
  }

  async readTextLines(
    path: string,
    options: EnvCallOptions & { maxLines?: number | undefined } = {},
  ): Promise<Result<string[], FileError>> {
    const absolute = this.absolute(path);
    const maxLines = options.maxLines;
    const result = await this.script(
      `if [ -d ${quote(absolute)} ]; then exit ${EXIT_IS_DIRECTORY}; fi
if [ ! -e ${quote(absolute)} ]; then exit ${EXIT_NOT_FOUND}; fi
if [ ! -r ${quote(absolute)} ]; then exit ${EXIT_PERMISSION}; fi
${maxLines === undefined ? `cat -- ${quote(absolute)}` : `head -n ${Math.max(0, Math.floor(maxLines))} -- ${quote(absolute)}`}`,
      options,
    );
    if (!result.ok) return result;
    return ok(splitLines(result.value.stdout).map((line) => line.text));
  }

  async openTextLineReader(
    path: string,
    options: EnvCallOptions = {},
  ): Promise<Result<TextLineReader, FileError>> {
    const absolute = this.absolute(path);
    // Probe first: opening a directory or a path that is not there is an error the
    // caller should see now, not on the first readLine.
    const probe = await this.fileInfo(absolute, options);
    if (!probe.ok) return err(probe.error);
    if (probe.value.kind === "directory")
      return err(fileError("is_directory", `${absolute} is a directory`));
    return ok(new SshLineReader(this, absolute, options));
  }

  // ---------------------------------------------------------------- writes

  async writeFile(
    path: string,
    content: string | Uint8Array,
    options: EnvCallOptions = {},
  ): Promise<Result<void, FileError>> {
    const absolute = this.absolute(path);
    const result = await this.script(
      `if [ -d ${quote(absolute)} ]; then exit ${EXIT_IS_DIRECTORY}; fi
parent=$(dirname -- ${quote(absolute)})
mkdir -p -- "$parent" || exit ${EXIT_PERMISSION}
cat > ${quote(absolute)} || exit ${EXIT_PERMISSION}`,
      { ...options, input: content },
    );
    return result.ok ? ok(undefined) : err(result.error);
  }

  async appendFile(
    path: string,
    content: string | Uint8Array,
    options: EnvCallOptions = {},
  ): Promise<Result<void, FileError>> {
    const absolute = this.absolute(path);
    const result = await this.script(
      `if [ -d ${quote(absolute)} ]; then exit ${EXIT_IS_DIRECTORY}; fi
parent=$(dirname -- ${quote(absolute)})
mkdir -p -- "$parent" || exit ${EXIT_PERMISSION}
cat >> ${quote(absolute)} || exit ${EXIT_PERMISSION}`,
      { ...options, input: content },
    );
    return result.ok ? ok(undefined) : err(result.error);
  }

  async renameFile(
    source: string,
    destination: string,
    options: EnvCallOptions = {},
  ): Promise<Result<void, FileError>> {
    const from = this.absolute(source);
    const to = this.absolute(destination);
    const result = await this.script(
      `if [ ! -e ${quote(from)} ]; then exit ${EXIT_NOT_FOUND}; fi
parent=$(dirname -- ${quote(to)})
mkdir -p -- "$parent" || exit ${EXIT_PERMISSION}
mv -f -- ${quote(from)} ${quote(to)} || exit ${EXIT_PERMISSION}`,
      options,
    );
    return result.ok ? ok(undefined) : err(result.error);
  }

  // ----------------------------------------------------------------- facts

  async fileInfo(
    path: string,
    options: EnvCallOptions = {},
  ): Promise<Result<FileInfo, FileError>> {
    const absolute = this.absolute(path);
    const result = await this.script(
      `if [ -L ${quote(absolute)} ]; then kind=symlink
elif [ -d ${quote(absolute)} ]; then kind=directory
elif [ -f ${quote(absolute)} ]; then kind=file
elif [ -e ${quote(absolute)} ]; then kind=symlink
else exit ${EXIT_NOT_FOUND}; fi
size=$(wc -c < ${quote(absolute)} 2>/dev/null | tr -d ' ')
mtime=$(stat -c %Y ${quote(absolute)} 2>/dev/null || stat -f %m ${quote(absolute)} 2>/dev/null || echo 0)
printf '%s\\t%s\\t%s' "$kind" "\${size:-0}" "$mtime"`,
      options,
    );
    if (!result.ok) return result;
    const [kind, size, mtime] = result.value.stdout.split("\t");
    return ok({
      name: basename(absolute),
      path: absolute,
      kind:
        kind === "directory"
          ? "directory"
          : kind === "symlink"
            ? "symlink"
            : "file",
      size: Number(size ?? 0) || 0,
      mtimeMs: (Number(mtime ?? 0) || 0) * 1000,
    });
  }

  async listDir(
    path: string,
    options: EnvCallOptions = {},
  ): Promise<Result<FileInfo[], FileError>> {
    const absolute = this.absolute(path);
    const result = await this.script(
      `if [ ! -e ${quote(absolute)} ]; then exit ${EXIT_NOT_FOUND}; fi
if [ ! -d ${quote(absolute)} ]; then exit ${EXIT_NOT_DIRECTORY}; fi
for entry in ${quote(absolute)}/* ${quote(absolute)}/.[!.]*; do
  [ -e "$entry" ] || continue
  [ -L "$entry" ] && kind=symlink
  [ -L "$entry" ] || { [ -d "$entry" ] && kind=directory || kind=file; }
  size=$(wc -c < "$entry" 2>/dev/null | tr -d ' ')
  mtime=$(stat -c %Y "$entry" 2>/dev/null || stat -f %m "$entry" 2>/dev/null || echo 0)
  printf '%s\\t%s\\t%s\\t%s\\n' "$kind" "\${size:-0}" "$mtime" "$(basename -- "$entry")"
done`,
      options,
    );
    if (!result.ok) return result;
    const entries: FileInfo[] = [];
    for (const line of splitLines(result.value.stdout)) {
      const [kind, size, mtime, ...rest] = line.text.split("\t");
      const name = rest.join("\t");
      if (name.length === 0) continue;
      entries.push({
        name,
        path: `${absolute === "/" ? "" : absolute}/${name}`,
        kind:
          kind === "directory"
            ? "directory"
            : kind === "symlink"
              ? "symlink"
              : "file",
        size: Number(size ?? 0) || 0,
        mtimeMs: (Number(mtime ?? 0) || 0) * 1000,
      });
    }
    return ok(entries);
  }

  async canonicalPath(
    path: string,
    options: EnvCallOptions = {},
  ): Promise<Result<string, FileError>> {
    const absolute = this.absolute(path);
    const result = await this.script(
      `if [ ! -e ${quote(absolute)} ] && [ ! -L ${quote(absolute)} ]; then exit ${EXIT_NOT_FOUND}; fi
if command -v realpath >/dev/null 2>&1; then realpath -- ${quote(absolute)} 2>/dev/null && exit 0; fi
if [ -d ${quote(absolute)} ]; then (cd -- ${quote(absolute)} && pwd -P); exit $?; fi
dir=$(dirname -- ${quote(absolute)})
base=$(basename -- ${quote(absolute)})
(cd -- "$dir" && printf '%s/%s' "$(pwd -P)" "$base")`,
      options,
    );
    if (!result.ok) return result;
    return ok(normalize(result.value.stdout.trim()));
  }

  async exists(
    path: string,
    options: EnvCallOptions = {},
  ): Promise<Result<boolean, FileError>> {
    if (options.signal?.aborted === true) return err(aborted());
    const absolute = this.absolute(path);
    const result = await this.script(
      `[ -e ${quote(absolute)} ] || [ -L ${quote(absolute)} ]`,
      options,
    );
    if (result.ok) return ok(true);
    if (result.error.code === "not_found") return ok(false);
    return err(result.error);
  }

  // ----------------------------------------------------------- directories

  async createDir(
    path: string,
    options: EnvCallOptions & { recursive?: boolean | undefined } = {},
  ): Promise<Result<void, FileError>> {
    const absolute = this.absolute(path);
    if (options.recursive === false) {
      const result = await this.script(
        `if [ -e ${quote(absolute)} ]; then exit ${EXIT_UNKNOWN}; fi
mkdir -- ${quote(absolute)} || exit ${EXIT_PERMISSION}`,
        options,
      );
      if (result.ok) return ok(undefined);
      return err(
        result.error.code === "unknown"
          ? fileError("unknown", `${absolute} already exists`)
          : result.error,
      );
    }
    const result = await this.script(
      `mkdir -p -- ${quote(absolute)} || exit ${EXIT_PERMISSION}`,
      options,
    );
    return result.ok ? ok(undefined) : err(result.error);
  }

  async remove(
    path: string,
    options: EnvCallOptions & {
      recursive?: boolean | undefined;
      force?: boolean | undefined;
    } = {},
  ): Promise<Result<void, FileError>> {
    const absolute = this.absolute(path);
    const recursive = options.recursive === true;
    const force = options.force === true;
    const result = await this.script(
      `if [ -d ${quote(absolute)} ] && [ ! -L ${quote(absolute)} ]; then
  ${recursive ? `rm -rf -- ${quote(absolute)}` : `rmdir -- ${quote(absolute)} 2>/dev/null || exit ${EXIT_UNKNOWN}`}
elif [ -e ${quote(absolute)} ] || [ -L ${quote(absolute)} ]; then
  rm -f -- ${quote(absolute)} || exit ${EXIT_PERMISSION}
elif [ ${force ? "1" : "0"} = 1 ]; then
  exit 0
else
  exit ${EXIT_NOT_FOUND}
fi`,
      options,
    );
    if (result.ok) return ok(undefined);
    if (result.error.code === "unknown" && !force) {
      return err(
        fileError(
          "unknown",
          `${absolute} is not empty (pass recursive to remove it)`,
        ),
      );
    }
    return err(result.error);
  }

  async createTempDir(
    prefix = "eta-",
    options: EnvCallOptions = {},
  ): Promise<Result<string, FileError>> {
    const result = await this.script(
      `dir=$(mktemp -d "\${TMPDIR:-/tmp}/${sanitizePrefix(prefix)}XXXXXX") || exit ${EXIT_PERMISSION}
printf '%s' "$dir"`,
      options,
    );
    if (!result.ok) return result;
    return ok(result.value.stdout.trim());
  }

  async createTempFile(
    options: EnvCallOptions & {
      prefix?: string | undefined;
      suffix?: string | undefined;
    } = {},
  ): Promise<Result<string, FileError>> {
    const prefix = sanitizePrefix(options.prefix ?? "eta-");
    const suffix = (options.suffix ?? "").replace(/[^A-Za-z0-9._-]/g, "");
    const template =
      suffix.length === 0 ? `${prefix}XXXXXX` : `${prefix}XXXXXX${suffix}`;
    const result = await this.script(
      `file=$(mktemp "\${TMPDIR:-/tmp}/${template}") || exit ${EXIT_PERMISSION}
printf '%s' "$file"`,
      options,
    );
    if (!result.ok) return result;
    return ok(result.value.stdout.trim());
  }

  async cleanup(): Promise<void> {
    await this.transport.close();
  }

  // ----------------------------------------------------------------- shell

  async exec(
    command: string,
    options: ShellExecOptions = {},
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const cwd =
      options.cwd === undefined
        ? this.cwd
        : resolvePath(this.cwd, options.cwd, this.transport.home);
    const limits = options.limits;
    const combined = limits === undefined ? undefined : outputBuffer(limits);
    const stdoutBuffer =
      limits === undefined ? undefined : outputBuffer(limits);
    const stderrBuffer =
      limits === undefined ? undefined : outputBuffer(limits);
    const live =
      combined === undefined || options.onUpdate === undefined
        ? undefined
        : new LiveOutput({
            buffer: combined,
            onUpdate: options.onUpdate,
            onError: () => undefined,
          });

    // What the model reads is the terminal's line — the two streams as they
    // arrived — while stdout and stderr stay separable for callers that want them.
    const envPrefix =
      options.env === undefined
        ? ""
        : Object.entries(options.env)
            .map(([k, v]) => `${k}=${quote(v)} `)
            .join("");
    const script = `cd -- ${quote(cwd)} || exit 126
${envPrefix}sh -c ${quote(command)}`;
    // `timeout` is in seconds, the transport's is in milliseconds.
    const runOptions: SshRunOptions =
      options.timeout === undefined
        ? {}
        : { timeoutMs: Math.max(1, Math.round(options.timeout * 1000)) };
    if (options.signal !== undefined) runOptions.signal = options.signal;
    runOptions.onChunk = (event) => {
      if (event.stream === "stdout") {
        combined?.push(event.chunk);
        stdoutBuffer?.push(event.chunk);
        live?.push(event.chunk);
        return;
      }
      // stderr counts towards what the model sees, but not towards stdout.
      combined?.push(event.chunk);
      stderrBuffer?.push(event.chunk);
      live?.push(event.chunk);
    };

    let result: SshResult;
    try {
      result = await this.transport.run(script, runOptions);
    } catch (error) {
      return err(
        new ExecutionError(
          "spawn_error",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
    live?.finish();
    combined?.finish();
    stdoutBuffer?.finish();
    stderrBuffer?.finish();
    if (result.timedOut === true) {
      return err(
        new ExecutionError(
          "timeout",
          `timeout:${options.timeout}`,
          undefined,
          combined?.snapshot().text,
        ),
      );
    }
    if (result.aborted === true || options.signal?.aborted === true) {
      return err(
        new ExecutionError(
          "aborted",
          "the command was aborted",
          undefined,
          combined?.snapshot().text,
        ),
      );
    }
    const bounded = combined?.snapshot();
    return ok({
      exitCode: result.code,
      stdout: stdoutBuffer?.snapshot().text ?? result.stdout,
      stderr: stderrBuffer?.snapshot().text ?? result.stderr,
      ...(bounded === undefined
        ? {}
        : { output: bounded.text, truncation: bounded.truncation }),
    });
  }

  // ------------------------------------------------------------- internals

  /** Read one window of a file from a byte offset, for the line reader. */
  async readWindow(
    path: string,
    from: number,
    bytes: number,
    signal?: AbortSignal,
  ): Promise<Result<string, FileError>> {
    const result = await this.script(
      `tail -c +${from} ${quote(path)} 2>/dev/null | head -c ${bytes}`,
      signal === undefined ? {} : { signal },
    );
    if (!result.ok) return err(result.error);
    return ok(result.value.stdout);
  }

  /** One script, with the exit codes translated to file error codes. */
  private async script(
    script: string,
    options: EnvCallOptions & { input?: string | Uint8Array | undefined } = {},
  ): Promise<Result<{ stdout: string; stderr: string }, FileError>> {
    const runOptions: SshRunOptions = {};
    if (options.input !== undefined) runOptions.input = options.input;
    if (options.signal !== undefined) runOptions.signal = options.signal;
    let result: SshResult;
    try {
      result = await this.transport.run(script, runOptions);
    } catch (error) {
      return err(
        fileError(
          "unknown",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
    if (options.signal?.aborted === true) return err(aborted());
    if (result.code === 0) return ok(result);
    return err(codeForExit(result.code, result.stderr, script));
  }

  private absolute(path: string): string {
    return resolvePath(this.cwd, path, this.transport.home);
  }
}

/** Read a remote text file in windows, one line at a time. */
class SshLineReader implements TextLineReader {
  private readonly env: SshEnvironment;
  private readonly path: string;
  private readonly openOptions: EnvCallOptions;
  private offset = 0;
  private buffer = "";
  private lines: TextLine[] = [];
  private done = false;

  constructor(env: SshEnvironment, path: string, openOptions: EnvCallOptions) {
    this.env = env;
    this.path = path;
    this.openOptions = openOptions;
  }

  async readLine(
    options: EnvCallOptions = {},
  ): Promise<Result<TextLine | undefined, FileError>> {
    const signal = options.signal ?? this.openOptions.signal;
    if (signal?.aborted === true) return err(aborted());
    for (;;) {
      const ready = this.lines.shift();
      if (ready !== undefined) return ok(ready);
      if (this.done) return ok(undefined);
      const fetched = await this.pull(signal);
      if (!fetched.ok) return fetched;
      if (fetched.value === 0) this.done = true;
    }
  }

  async close(): Promise<void> {
    this.buffer = "";
    this.lines = [];
    this.done = true;
  }

  /** Fetch one more window; returns how many bytes arrived (0 at the end). */
  private async pull(
    signal: AbortSignal | undefined,
  ): Promise<Result<number, FileError>> {
    const from = this.offset + 1;
    const window = await this.env.readWindow(
      this.path,
      from,
      READER_WINDOW_BYTES,
      signal,
    );
    if (!window.ok) return err(window.error);
    const chunk = window.value;
    if (chunk.length === 0) return ok(0);
    this.offset += Buffer.byteLength(chunk);
    this.buffer += chunk;
    const parsed = splitLines(this.buffer);
    if (parsed.length === 0) return ok(chunk.length);
    // Everything but a trailing unterminated piece is a complete line for now.
    const trailing = this.buffer.endsWith("\n") ? [] : parsed.slice(-1);
    const complete = this.buffer.endsWith("\n") ? parsed : parsed.slice(0, -1);
    this.lines.push(...complete);
    this.buffer = trailing.length === 0 ? "" : trailing[0]!.text;
    return ok(chunk.length);
  }
}

// ----------------------------------------------------------------- helpers

function aborted(): FileError {
  return fileError("aborted", "the call was aborted");
}

function fileError(code: FileError["code"], message: string): FileError {
  return new FileError(code, message);
}

function outputBuffer(limits: ShellOutputLimits): OutputBuffer {
  return new OutputBuffer({
    maxBytes: limits.maxBytes,
    maxLines: limits.maxLines,
    retain: limits.retain === "head" ? "head" : "tail",
  });
}

/** The file error a script's exit code means. */
function codeForExit(code: number, stderr: string, script: string): FileError {
  const detail = stderr.trim().split("\n").at(-1) ?? "";
  const suffix = detail.length === 0 ? "" : `: ${detail}`;
  switch (code) {
    case EXIT_NOT_FOUND:
      return fileError("not_found", `not found${suffix}`);
    case EXIT_IS_DIRECTORY:
      return fileError("is_directory", `is a directory${suffix}`);
    case EXIT_NOT_DIRECTORY:
      return fileError("not_directory", `is not a directory${suffix}`);
    case EXIT_PERMISSION:
      return fileError("permission_denied", `permission denied${suffix}`);
    case 126:
      return fileError("not_found", `no such directory${suffix}`);
    default:
      return fileError(
        "unknown",
        detail.length > 0 ? detail : `${script.slice(0, 80)} exited ${code}`,
      );
  }
}

function quote(value: string): string {
  return shellQuote(value);
}

function sanitizePrefix(prefix: string): string {
  return prefix.replace(/[^A-Za-z0-9._-]/g, "");
}

function basename(path: string): string {
  const trimmed = path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/** Resolve `path` against the environment's own rules: absolute stays, `~` is home. */
export function resolvePath(cwd: string, path: string, home: string): string {
  if (path.length === 0) return normalize(cwd);
  if (path === "~") return normalize(home);
  if (path.startsWith("~/")) return normalize(`${home}/${path.slice(2)}`);
  if (path.startsWith("file://"))
    return normalize(decodeURIComponent(path.slice("file://".length)));
  if (path.startsWith("/")) return normalize(path);
  return normalize(`${cwd}/${path}`);
}

/** Collapse `.`, `..` and doubled slashes, as POSIX resolution does. */
export function normalize(path: string): string {
  const absolute = path.startsWith("/");
  const parts = path.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(part);
  }
  const joined = stack.join("/");
  if (absolute) return `/${joined}`;
  return joined;
}

function splitLines(text: string): TextLine[] {
  if (text.length === 0) return [];
  const lines: TextLine[] = [];
  let start = 0;
  for (;;) {
    const index = text.indexOf("\n", start);
    if (index === -1) {
      if (start < text.length)
        lines.push({ text: text.slice(start), terminated: false });
      return lines;
    }
    lines.push({ text: text.slice(start, index), terminated: true });
    start = index + 1;
    if (start === text.length) return lines;
  }
}
