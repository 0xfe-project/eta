/**
 * MemoryEnvironment — an execution environment that is a Map (ported shape from
 * eta-agent's filesystem contract, minus the disk).
 *
 * Two jobs:
 * - a session under test gets a filesystem that behaves like one without
 *   touching the machine, so tool tests are hermetic and parallel;
 * - it is the second implementation the env contract runs against, which is what
 *   keeps the seam honest: a tool written against `ExecutionEnv` must work on
 *   both, and any semantic that only one backend has shows up as a failing
 *   contract test rather than as a bug on a user's machine.
 *
 * The shell is scripted rather than emulated: `shell` receives the command and
 * answers. There is no pretending to be bash in a Map — a test that wants a real
 * shell uses `NodeEnvironment`.
 */

import type {
  EnvCallOptions,
  ExecutionEnv,
  ExecutionError,
  FileError,
  FileInfo,
  FileKind,
  Result,
  ShellExecOptions,
  ShellExecResult,
  TextLine,
  TextLineReader,
} from "@eta/execution";
import {
  err,
  ExecutionError as ExecutionErrorClass,
  FileError as FileErrorClass,
  ok,
} from "@eta/execution";

interface MemoryNode {
  kind: FileKind;
  /** File bytes. */
  content: Uint8Array | undefined;
  /** Symlink target, as addressed. */
  target: string | undefined;
  mtimeMs: number;
}

/** What the scripted shell is handed. */
export interface MemoryShellCall {
  command: string;
  cwd: string;
  timeout: number | undefined;
  signal: AbortSignal | undefined;
}

export interface MemoryEnvironmentOptions {
  /** Working directory. Defaults to `/work`. */
  cwd?: string;
  /** Seed files: path (absolute, or relative to `cwd`) → UTF-8 content. */
  files?: Record<string, string>;
  /** Seed directories. */
  dirs?: string[];
  /** Seed symlinks: path → target. */
  symlinks?: Record<string, string>;
  /**
   * The shell. Without one, every command reports `shell_unavailable` — a
   * memory environment does not pretend to run programs.
   */
  shell?: (call: MemoryShellCall) => ShellExecResult | Promise<ShellExecResult>;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Collapse `.`, `..`, and repeated separators, leaving an absolute path. */
function normalizePath(path: string): string {
  const segments = path.split("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return `/${out.join("/")}`;
}

function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter((part) => part.length > 0).join("/"));
}

function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

/** A filesystem in a Map, plus a scripted shell. */
export class MemoryEnvironment implements ExecutionEnv {
  readonly cwd: string;
  private readonly nodes = new Map<string, MemoryNode>();
  private readonly shellRunner: MemoryEnvironmentOptions["shell"];
  private tempCounter = 0;
  private tempRoot = "/tmp";

  constructor(options: MemoryEnvironmentOptions = {}) {
    this.cwd = normalizePath(options.cwd ?? "/work");
    this.shellRunner = options.shell;
    this.nodes.set("/", {
      kind: "directory",
      content: undefined,
      target: undefined,
      mtimeMs: Date.now(),
    });
    this.ensureDirectory(this.cwd);
    for (const dir of options.dirs ?? [])
      this.createDirectoryNode(this.resolve(dir));
    for (const [path, content] of Object.entries(options.files ?? {})) {
      this.writeFileNode(this.resolve(path), textEncoder.encode(content));
    }
    for (const [path, target] of Object.entries(options.symlinks ?? {})) {
      const resolved = this.resolve(path);
      this.nodes.set(resolved, {
        kind: "symlink",
        content: undefined,
        target: this.resolve(target),
        mtimeMs: Date.now(),
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Paths                                                             */
  /* ---------------------------------------------------------------- */

  /** An absolute addressed path, without requiring it to exist. */
  async absolutePath(
    path: string,
    options?: EnvCallOptions,
  ): Promise<Result<string, FileError>> {
    const aborted = this.aborted(options);
    if (aborted !== undefined) return err(aborted);
    return ok(this.resolve(path));
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return ok(joinPath(...parts));
  }

  private resolve(path: string): string {
    return path.startsWith("/")
      ? normalizePath(path)
      : joinPath(this.cwd, path);
  }

  /** A directory the environment created for itself, with every parent. */
  private createDirectoryNode(path: string): void {
    const segments = path.split("/").filter((segment) => segment.length > 0);
    let current = "";
    for (const segment of segments) {
      current = `${current}/${segment}`;
      if (!this.nodes.has(current)) {
        this.nodes.set(current, {
          kind: "directory",
          content: undefined,
          target: undefined,
          mtimeMs: Date.now(),
        });
      }
    }
  }

  private ensureDirectory(path: string): void {
    this.createDirectoryNode(path);
  }

  private aborted(options?: EnvCallOptions): FileError | undefined {
    if (options?.signal?.aborted !== true) return undefined;
    return new FileErrorClass("aborted", "the operation was aborted");
  }

  /* ---------------------------------------------------------------- */
  /* Reads                                                             */
  /* ---------------------------------------------------------------- */

  private node(
    path: string,
    options?: EnvCallOptions,
  ): Result<MemoryNode, FileError> {
    const aborted = this.aborted(options);
    if (aborted !== undefined) return err(aborted);
    const node = this.nodes.get(path);
    if (node === undefined)
      return err(
        new FileErrorClass(
          "not_found",
          `no such file or directory: ${path}`,
          path,
        ),
      );
    return ok(node);
  }

  private fileNode(
    path: string,
    options?: EnvCallOptions,
  ): Result<MemoryNode, FileError> {
    const found = this.node(path, options);
    if (!found.ok) return found;
    if (found.value.kind === "directory") {
      return err(
        new FileErrorClass("is_directory", `is a directory: ${path}`, path),
      );
    }
    return found;
  }

  async readTextFile(
    path: string,
    options?: EnvCallOptions,
  ): Promise<Result<string, FileError>> {
    const resolved = this.resolve(path);
    const node = this.fileNode(resolved, options);
    if (!node.ok) return node;
    return ok(textDecoder.decode(node.value.content ?? new Uint8Array()));
  }

  async readTextLines(
    path: string,
    options?: EnvCallOptions & { maxLines?: number },
  ): Promise<Result<string[], FileError>> {
    const read = await this.readTextFile(path, options);
    if (!read.ok) return read;
    const lines = splitTextIntoLines(read.value);
    const limited =
      options?.maxLines === undefined
        ? lines
        : lines.slice(0, options.maxLines);
    return ok(limited);
  }

  async openTextLineReader(
    path: string,
    options?: EnvCallOptions,
  ): Promise<Result<TextLineReader, FileError>> {
    const read = await this.readTextFile(path, options);
    if (!read.ok) return read;
    const lines = splitTextIntoReaderLines(read.value);
    let index = 0;
    return ok({
      readLine: async (
        callOptions?: EnvCallOptions,
      ): Promise<Result<TextLine | undefined, FileError>> => {
        const aborted = this.aborted(callOptions);
        if (aborted !== undefined) return err(aborted);
        if (index >= lines.length) return ok(undefined);
        const line = lines[index]!;
        index += 1;
        return ok(line);
      },
      close: async () => undefined,
    });
  }

  async readBinaryFile(
    path: string,
    options?: EnvCallOptions,
  ): Promise<Result<Uint8Array, FileError>> {
    const resolved = this.resolve(path);
    const node = this.fileNode(resolved, options);
    if (!node.ok) return node;
    return ok(new Uint8Array(node.value.content ?? new Uint8Array()));
  }

  /* ---------------------------------------------------------------- */
  /* Writes                                                            */
  /* ---------------------------------------------------------------- */

  async writeFile(
    path: string,
    content: string | Uint8Array,
    options?: EnvCallOptions,
  ): Promise<Result<void, FileError>> {
    const aborted = this.aborted(options);
    if (aborted !== undefined) return err(aborted);
    const resolved = this.resolve(path);
    const existing = this.nodes.get(resolved);
    if (existing?.kind === "directory") {
      return err(
        new FileErrorClass(
          "is_directory",
          `is a directory: ${resolved}`,
          resolved,
        ),
      );
    }
    this.writeFileNode(
      resolved,
      typeof content === "string" ? textEncoder.encode(content) : content,
    );
    return ok(undefined);
  }

  async appendFile(
    path: string,
    content: string | Uint8Array,
    options?: EnvCallOptions,
  ): Promise<Result<void, FileError>> {
    const aborted = this.aborted(options);
    if (aborted !== undefined) return err(aborted);
    const resolved = this.resolve(path);
    const existing = this.nodes.get(resolved);
    if (existing?.kind === "directory") {
      return err(
        new FileErrorClass(
          "is_directory",
          `is a directory: ${resolved}`,
          resolved,
        ),
      );
    }
    const bytes =
      typeof content === "string" ? textEncoder.encode(content) : content;
    const previous = existing?.content ?? new Uint8Array();
    const combined = new Uint8Array(previous.length + bytes.length);
    combined.set(previous, 0);
    combined.set(bytes, previous.length);
    this.writeFileNode(resolved, combined);
    return ok(undefined);
  }

  private writeFileNode(path: string, content: Uint8Array): void {
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent.length > 0) this.ensureDirectory(parent);
    this.nodes.set(path, {
      kind: "file",
      content,
      target: undefined,
      mtimeMs: Date.now(),
    });
  }

  async renameFile(
    source: string,
    destination: string,
    options?: EnvCallOptions,
  ): Promise<Result<void, FileError>> {
    const aborted = this.aborted(options);
    if (aborted !== undefined) return err(aborted);
    const from = this.resolve(source);
    const to = this.resolve(destination);
    const node = this.nodes.get(from);
    if (node === undefined)
      return err(
        new FileErrorClass(
          "not_found",
          `no such file or directory: ${from}`,
          from,
        ),
      );
    this.nodes.delete(from);
    const parent = to.slice(0, to.lastIndexOf("/"));
    if (parent.length > 0) this.ensureDirectory(parent);
    this.nodes.set(to, node);
    return ok(undefined);
  }

  async createDir(
    path: string,
    options?: EnvCallOptions & { recursive?: boolean },
  ): Promise<Result<void, FileError>> {
    const aborted = this.aborted(options);
    if (aborted !== undefined) return err(aborted);
    const resolved = this.resolve(path);
    const existing = this.nodes.get(resolved);
    if (existing !== undefined && existing.kind !== "directory") {
      return err(
        new FileErrorClass(
          "not_directory",
          `not a directory: ${resolved}`,
          resolved,
        ),
      );
    }
    if (existing !== undefined) return ok(undefined);
    if (options?.recursive === false) {
      const parent = resolved.slice(0, resolved.lastIndexOf("/"));
      if (parent.length > 0 && this.nodes.get(parent)?.kind !== "directory") {
        return err(
          new FileErrorClass(
            "not_found",
            `no such file or directory: ${parent}`,
            parent,
          ),
        );
      }
      this.nodes.set(resolved, {
        kind: "directory",
        content: undefined,
        target: undefined,
        mtimeMs: Date.now(),
      });
      return ok(undefined);
    }
    this.ensureDirectory(resolved);
    return ok(undefined);
  }

  async remove(
    path: string,
    options?: EnvCallOptions & { recursive?: boolean; force?: boolean },
  ): Promise<Result<void, FileError>> {
    const aborted = this.aborted(options);
    if (aborted !== undefined) return err(aborted);
    const resolved = this.resolve(path);
    const node = this.nodes.get(resolved);
    if (node === undefined) {
      if (options?.force === true) return ok(undefined);
      return err(
        new FileErrorClass(
          "not_found",
          `no such file or directory: ${resolved}`,
          resolved,
        ),
      );
    }
    if (node.kind === "directory") {
      const children = this.childrenOf(resolved);
      if (children.length > 0 && options?.recursive !== true) {
        return err(
          new FileErrorClass(
            "invalid",
            `directory not empty: ${resolved}`,
            resolved,
          ),
        );
      }
      for (const child of children) {
        this.nodes.delete(child);
      }
    }
    this.nodes.delete(resolved);
    return ok(undefined);
  }

  private childrenOf(path: string): string[] {
    const prefix = path === "/" ? "/" : `${path}/`;
    const children: string[] = [];
    for (const key of this.nodes.keys()) {
      if (key === path || !key.startsWith(prefix)) continue;
      // Direct children only.
      if (!key.slice(prefix.length).includes("/")) children.push(key);
    }
    return children;
  }

  /* ---------------------------------------------------------------- */
  /* Metadata                                                          */
  /* ---------------------------------------------------------------- */

  async fileInfo(
    path: string,
    options?: EnvCallOptions,
  ): Promise<Result<FileInfo, FileError>> {
    const resolved = this.resolve(path);
    const node = this.node(resolved, options);
    if (!node.ok) return node;
    return ok(this.infoOf(resolved, node.value));
  }

  private infoOf(path: string, node: MemoryNode): FileInfo {
    return {
      name: basename(path),
      path,
      kind: node.kind,
      size:
        node.kind === "file"
          ? (node.content?.length ?? 0)
          : node.kind === "symlink"
            ? (node.target?.length ?? 0)
            : 0,
      mtimeMs: node.mtimeMs,
    };
  }

  async listDir(
    path: string,
    options?: EnvCallOptions,
  ): Promise<Result<FileInfo[], FileError>> {
    const resolved = this.resolve(path);
    const node = this.node(resolved, options);
    if (!node.ok) return node;
    if (node.value.kind !== "directory") {
      return err(
        new FileErrorClass(
          "not_directory",
          `not a directory: ${resolved}`,
          resolved,
        ),
      );
    }
    const infos = this.childrenOf(resolved)
      .sort()
      .map((child) => this.infoOf(child, this.nodes.get(child)!));
    return ok(infos);
  }

  async canonicalPath(
    path: string,
    options?: EnvCallOptions,
  ): Promise<Result<string, FileError>> {
    const resolved = this.resolve(path);
    const node = this.node(resolved, options);
    if (!node.ok) return node;
    if (node.value.kind !== "symlink" || node.value.target === undefined)
      return ok(resolved);
    // Resolve a chain, refusing to loop forever.
    let current = node.value.target;
    for (let hop = 0; hop < 32; hop += 1) {
      const next = this.nodes.get(current);
      if (next === undefined)
        return err(
          new FileErrorClass(
            "not_found",
            `no such file or directory: ${current}`,
            current,
          ),
        );
      if (next.kind !== "symlink" || next.target === undefined)
        return ok(current);
      current = next.target;
    }
    return err(
      new FileErrorClass(
        "invalid",
        `too many levels of symbolic links: ${resolved}`,
        resolved,
      ),
    );
  }

  async exists(
    path: string,
    options?: EnvCallOptions,
  ): Promise<Result<boolean, FileError>> {
    const aborted = this.aborted(options);
    if (aborted !== undefined) return err(aborted);
    return ok(this.nodes.has(this.resolve(path)));
  }

  /* ---------------------------------------------------------------- */
  /* Temp                                                              */
  /* ---------------------------------------------------------------- */

  async createTempDir(
    prefix = "tmp-",
    options?: EnvCallOptions,
  ): Promise<Result<string, FileError>> {
    const aborted = this.aborted(options);
    if (aborted !== undefined) return err(aborted);
    this.ensureDirectory(this.tempRoot);
    this.tempCounter += 1;
    const path = joinPath(this.tempRoot, `${prefix}${this.tempCounter}`);
    this.ensureDirectory(path);
    return ok(path);
  }

  async createTempFile(
    options?: EnvCallOptions & { prefix?: string; suffix?: string },
  ): Promise<Result<string, FileError>> {
    const aborted = this.aborted(options);
    if (aborted !== undefined) return err(aborted);
    this.ensureDirectory(this.tempRoot);
    this.tempCounter += 1;
    const path = joinPath(
      this.tempRoot,
      `${options?.prefix ?? ""}${this.tempCounter}${options?.suffix ?? ""}`,
    );
    this.writeFileNode(path, new Uint8Array());
    return ok(path);
  }

  /** Where this environment puts its temporary files. Tests may point it elsewhere. */
  setTempRoot(path: string): void {
    this.tempRoot = this.resolve(path);
    this.ensureDirectory(this.tempRoot);
  }

  async cleanup(): Promise<void> {
    // Nothing to release: the nodes are garbage-collected with the instance.
  }

  /* ---------------------------------------------------------------- */
  /* Shell                                                             */
  /* ---------------------------------------------------------------- */

  async exec(
    command: string,
    options?: ShellExecOptions,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (options?.signal?.aborted === true) {
      return err(new ExecutionErrorClass("aborted", "the command was aborted"));
    }
    if (this.shellRunner === undefined) {
      return err(
        new ExecutionErrorClass(
          "shell_unavailable",
          "this memory environment has no shell: seed one with `shell: (call) => ...`",
        ),
      );
    }
    const cwd =
      options?.cwd === undefined ? this.cwd : this.resolve(options.cwd);
    try {
      const result = await this.shellRunner({
        command,
        cwd,
        timeout: options?.timeout,
        signal: options?.signal,
      });
      return ok(result);
    } catch (error) {
      return err(
        new ExecutionErrorClass(
          "spawn_error",
          error instanceof Error ? error.message : String(error),
          error as Error,
        ),
      );
    }
  }
}

/** The text's lines, without terminators: a trailing newline is not an empty line. */
function splitTextIntoLines(text: string): string[] {
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** The text's lines with their terminator flags, for a reader. */
function splitTextIntoReaderLines(text: string): TextLine[] {
  return splitTextIntoLines(text).map((line, index, all) => ({
    text: line,
    // Only the last line of an unterminated file is torn.
    terminated: index < all.length - 1 || text.endsWith("\n"),
  }));
}
