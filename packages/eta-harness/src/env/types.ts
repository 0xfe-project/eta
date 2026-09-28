/**
 * The execution environment seam (ported from eta-agent's `harness/types.ts`).
 *
 * Everything the built-in tools touch — the filesystem and the shell — goes
 * through this interface, so a session can run against the local machine, a
 * container, or a machine reached over SSH (a plugin) without the tools
 * knowing. It lives in the harness rather than the kernel: the runner never
 * reads a file or runs a command, and core keeps no path vocabulary at all.
 *
 * Two shapes of failure, both explicit:
 * - `Result<T, FileError>` for the filesystem — a missing file is an answer, not
 *   an exception, and the codes are backend-independent so a tool can map them
 *   to a message without guessing at a platform's error strings.
 * - `Result<T, ExecutionError>` for `exec` — the same idea for timeouts,
 *   aborts, and shells that will not start.
 *
 * The one deliberate difference from eta-agent: where it threads a chord
 * `Context` (carrying an abort signal) through every call, these take an
 * optional `{ signal }` — the same capability with no extra dependency, since
 * kernel tool calls already carry the run's signal (`ToolCallInfo.signal`).
 */

/** The codebase's one Result shape. */
export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };

/** A successful {@link Result}. */
export function ok<TValue>(value: TValue): Result<TValue, never> {
	return { ok: true, value };
}

/** A failed {@link Result}. */
export function err<TError>(error: TError): Result<never, TError> {
	return { ok: false, error };
}

/** The success value, or the failure thrown. For tests and adapter boundaries. */
export function getOrThrow<TValue, TError>(result: Result<TValue, TError>): TValue {
	if (!result.ok) throw result.error;
	return result.value;
}

/** The success value when it is an object, else `undefined`. */
export function getOrUndefined<TValue extends object, TError>(result: Result<TValue, TError>): TValue | undefined {
	return result.ok ? result.value : undefined;
}

/** What one environment call may be told; the signal is the run's. */
export interface EnvCallOptions {
	/** Aborts the operation: a cancelled call must not keep reading or spawning. */
	signal?: AbortSignal | undefined;
}

/** Kind of filesystem object as addressed. Symlinks are never followed implicitly. */
export type FileKind = "file" | "directory" | "symlink";

/** Stable, backend-independent file error codes. */
export type FileErrorCode =
	| "aborted"
	| "not_found"
	| "permission_denied"
	| "not_directory"
	| "is_directory"
	| "invalid"
	| "not_supported"
	| "unknown";

/** An environment failure, with a code a tool can translate. */
export class FileError extends Error {
	/** Backend-independent error code. */
	readonly code: FileErrorCode;
	/** The absolute addressed path the failure concerns, when there is one. */
	readonly path: string | undefined;

	constructor(code: FileErrorCode, message: string, path?: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "FileError";
		this.code = code;
		this.path = path;
	}
}

/** Stable, backend-independent execution error codes. */
export type ExecutionErrorCode = "aborted" | "timeout" | "shell_unavailable" | "spawn_error" | "unknown";

/** A shell failure that is not a command's own exit code. */
export class ExecutionError extends Error {
	/** Backend-independent error code. */
	readonly code: ExecutionErrorCode;

	constructor(code: ExecutionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ExecutionError";
		this.code = code;
	}
}

/** Metadata for an addressed path, without following symlinks. */
export interface FileInfo {
	/** Basename of {@link path}. */
	name: string;
	/** Absolute, syntactically normalized addressed path. */
	path: string;
	kind: FileKind;
	/** Size in bytes. */
	size: number;
	/** Modification time, milliseconds since the Unix epoch. */
	mtimeMs: number;
}

/** One line of a text file. */
export interface TextLine {
	text: string;
	/** Whether the line ended with a newline; a torn final record says `false`. */
	terminated: boolean;
}

/** Pull-based line reading: a reader holds one file open and yields lines. */
export interface TextLineReader {
	readLine(options?: EnvCallOptions): Promise<Result<TextLine | undefined, FileError>>;
	/** Release the open file. Best-effort: must not throw or reject. */
	close(): Promise<void>;
}

/** The filesystem half of an execution environment. */
export interface FileSystem {
	/** Current working directory; relative paths resolve against it. */
	cwd: string;

	/** An absolute addressed path, without requiring it to exist or resolving symlinks. */
	absolutePath(path: string, options?: EnvCallOptions): Promise<Result<string, FileError>>;
	/** Join path segments without requiring the result to exist. */
	joinPath(parts: string[], options?: EnvCallOptions): Promise<Result<string, FileError>>;
	/** Read a UTF-8 text file. */
	readTextFile(path: string, options?: EnvCallOptions): Promise<Result<string, FileError>>;
	/** Open a UTF-8 text file for pull-based line reading. */
	openTextLineReader(path: string, options?: EnvCallOptions): Promise<Result<TextLineReader, FileError>>;
	/** Read UTF-8 text lines; implementations may stop once `maxLines` is reached. */
	readTextLines(path: string, options?: EnvCallOptions & { maxLines?: number }): Promise<Result<string[], FileError>>;
	/** Read a binary file. */
	readBinaryFile(path: string, options?: EnvCallOptions): Promise<Result<Uint8Array, FileError>>;
	/** Create or overwrite a file, creating parent directories when supported. */
	writeFile(path: string, content: string | Uint8Array, options?: EnvCallOptions): Promise<Result<void, FileError>>;
	/** Create or append to a file, creating parent directories when supported. */
	appendFile(path: string, content: string | Uint8Array, options?: EnvCallOptions): Promise<Result<void, FileError>>;
	/** Atomically rename, replacing the destination when it exists. No cross-filesystem copies. */
	renameFile(source: string, destination: string, options?: EnvCallOptions): Promise<Result<void, FileError>>;
	/** Metadata for the addressed path, without following symlinks. */
	fileInfo(path: string, options?: EnvCallOptions): Promise<Result<FileInfo, FileError>>;
	/** Direct children of a directory, without following symlinks. */
	listDir(path: string, options?: EnvCallOptions): Promise<Result<FileInfo[], FileError>>;
	/** The canonical path of an existing path, resolving symlinks where supported. */
	canonicalPath(path: string, options?: EnvCallOptions): Promise<Result<string, FileError>>;
	/** False for a missing path; permission failures are errors, not `false`. */
	exists(path: string, options?: EnvCallOptions): Promise<Result<boolean, FileError>>;
	/** Create a directory. Defaults to `recursive: true`. */
	createDir(path: string, options?: EnvCallOptions & { recursive?: boolean }): Promise<Result<void, FileError>>;
	/** Remove a file or directory. Defaults to `recursive: false`, `force: false`. */
	remove(
		path: string,
		options?: EnvCallOptions & { recursive?: boolean; force?: boolean },
	): Promise<Result<void, FileError>>;
	/** Create a temporary directory; defaults to `prefix: "tmp-"`. */
	createTempDir(prefix?: string, options?: EnvCallOptions): Promise<Result<string, FileError>>;
	/** Create a temporary file; defaults to no prefix and suffix. */
	createTempFile(options?: EnvCallOptions & { prefix?: string; suffix?: string }): Promise<Result<string, FileError>>;
	/** Release filesystem resources. Best-effort: must not throw or reject. */
	cleanup(): Promise<void>;
}

/** What one shell call may be told. */
export interface ShellExecOptions {
	/** Working directory; relative paths resolve against {@link FileSystem.cwd}. Defaults to it. */
	cwd?: string | undefined;
	/** Extra environment variables, layered over the inherited ones. */
	env?: Record<string, string> | undefined;
	/** Whether to inherit the environment's own variables. Defaults to true. */
	inheritEnv?: boolean | undefined;
	/** Kill the command after this many seconds, reporting a timeout. */
	timeout?: number | undefined;
	/** Aborts the command with the run. */
	signal?: AbortSignal | undefined;
	/** How much output to keep before the rest is dropped or spilled (see truncation, H's E4). */
	limits?: ShellOutputLimits | undefined;
	/** Write the full output to a temporary file once the limits are crossed. */
	spill?: boolean | undefined;
}

/** Where the middle of a long output went. */
export interface ShellTruncation {
	truncated: boolean;
	truncatedBy?: "lines" | "bytes" | undefined;
	totalLines: number;
	outputLines: number;
	totalBytes: number;
	outputBytes: number;
	/** The last kept line was cut mid-line. */
	lastLinePartial: boolean;
}

/** Bounded output: at most `maxLines` lines and `maxBytes` bytes, keeping the tail. */
export interface ShellOutputLimits {
	maxBytes: number;
	maxLines: number;
	/** Which end to keep. Defaults to `"tail"`. */
	retain?: "head" | "tail" | "head-tail" | undefined;
}

/** What a command did. */
export interface ShellExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	/** Set when the output crossed the limits. */
	truncation?: ShellTruncation | undefined;
	/** Where the whole output went, when the caller asked it to spill. */
	spillPath?: string | undefined;
}

/** The shell half of an execution environment. */
export interface Shell {
	/** Run a shell command in {@link FileSystem.cwd} unless told otherwise. */
	exec(command: string, options?: ShellExecOptions): Promise<Result<ShellExecResult, ExecutionError>>;
	/** Release shell resources. Best-effort: must not throw or reject. */
	cleanup(): Promise<void>;
}

/** What a tool is handed: a filesystem and a shell. */
export interface ExecutionEnv extends FileSystem, Shell {}
