/**
 * NodeFileSystem — the local backend's filesystem half (port of eta-agent's
 * `harness/env/nodejs.ts`, fs side).
 *
 * Faithful where it matters and deliberate where eta was silent:
 * - every failure becomes a `FileError` with a backend-independent code, mapped
 *   from the platform's errno (`ENOENT` → `not_found`, `EISDIR` → `is_directory`,
 *   `ENOTDIR` → `not_directory`, `EACCES`/`EPERM` → `permission_denied`);
 * - `~`, `~/…` and `file://` are resolved, and everything else is resolved
 *   against `cwd` — no sandbox: a coding agent's home is the machine, and `cwd`
 *   is where it starts, exactly as in eta-agent;
 * - reads honour the run's abort signal *between* operations, and the line
 *   reader reads by explicit byte offset so an aborted read can be retried
 *   without skipping bytes;
 * - the line reader is its own strict-LF parser rather than `readline`, because
 *   `readline` does not say whether the last line was newline-terminated, and
 *   the caller needs to know (a torn final line is how a crash shows up).
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	access,
	appendFile,
	lstat,
	mkdir,
	mkdtemp,
	open as openFile,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type EnvCallOptions,
	err,
	type FileError,
	FileError as FileErrorClass,
	type FileInfo,
	type FileKind,
	type FileSystem,
	ok,
	type Result,
	type TextLine,
	type TextLineReader,
} from "@eta/execution";

/** Turn an unknown failure into a coded `FileError`. */
export function toFileError(error: unknown, fallbackPath?: string): FileError {
	if (error instanceof FileErrorClass) return error;
	const cause = error instanceof Error ? error : new Error(String(error));
	const nodeError = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException) : undefined;
	const path = typeof nodeError?.path === "string" ? nodeError.path : fallbackPath;
	switch (nodeError?.code) {
		case "ABORT_ERR":
			return new FileErrorClass("aborted", cause.message, path, cause);
		case "ENOENT":
			return new FileErrorClass("not_found", cause.message, path, cause);
		case "EACCES":
		case "EPERM":
			return new FileErrorClass("permission_denied", cause.message, path, cause);
		case "ENOTDIR":
			return new FileErrorClass("not_directory", cause.message, path, cause);
		case "EISDIR":
			return new FileErrorClass("is_directory", cause.message, path, cause);
		case "EINVAL":
			return new FileErrorClass("invalid", cause.message, path, cause);
		default:
			return new FileErrorClass("unknown", cause.message, path, cause);
	}
}

/** The abort answer for a call whose signal is already aborted. */
function aborted<TValue>(options: EnvCallOptions | undefined, path?: string): Result<TValue, FileError> | undefined {
	return options?.signal?.aborted === true
		? err(new FileErrorClass("aborted", "the operation was aborted", path))
		: undefined;
}

/** `~`, `~/…` and `file://` resolved; everything else against `cwd`. */
export function resolveEnvPath(cwd: string, path: string): string {
	let normalized = path;
	if (normalized === "~") normalized = homedir();
	else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		normalized = join(homedir(), normalized.slice(2));
	} else if (normalized.startsWith("file://")) {
		try {
			normalized = fileURLToPath(normalized);
		} catch {
			// A malformed URL stays an ordinary path: these methods never throw.
		}
	}
	return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

function kindOf(stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileKind | undefined {
	if (stats.isFile()) return "file";
	if (stats.isDirectory()) return "directory";
	if (stats.isSymbolicLink()) return "symlink";
	return undefined;
}

function infoOf(
	path: string,
	stats: { size: number; mtimeMs: number } & Parameters<typeof kindOf>[0],
): Result<FileInfo, FileError> {
	const kind = kindOf(stats);
	if (kind === undefined) return err(new FileErrorClass("invalid", "Unsupported file type", path));
	return ok({ name: basename(path), path, kind, size: stats.size, mtimeMs: stats.mtimeMs });
}

/**
 * A reader that yields lines and says whether each one was newline-terminated.
 * Reads by explicit byte offset, so aborting mid-read does not lose bytes.
 */
class NodeTextLineReader implements TextLineReader {
	private readonly file: Awaited<ReturnType<typeof openFile>>;
	private readonly path: string;
	private readonly decoder = new TextDecoder();
	private readonly chunk = new Uint8Array(64 * 1024);
	private byteOffset = 0;
	private buffered = "";
	private ended = false;
	private closed = false;

	constructor(file: Awaited<ReturnType<typeof openFile>>, path: string) {
		this.file = file;
		this.path = path;
	}

	async readLine(options?: EnvCallOptions): Promise<Result<TextLine | undefined, FileError>> {
		const alreadyAborted = aborted<TextLine | undefined>(options, this.path);
		if (alreadyAborted) return alreadyAborted;
		if (this.closed) return err(new FileErrorClass("invalid", "Text line reader is closed", this.path));

		try {
			for (;;) {
				const newline = this.buffered.indexOf("\n");
				if (newline !== -1) {
					const text = this.buffered.slice(0, newline);
					this.buffered = this.buffered.slice(newline + 1);
					return ok({ text, terminated: true });
				}
				if (this.ended) {
					if (this.buffered.length === 0) return ok(undefined);
					const text = this.buffered;
					this.buffered = "";
					return ok({ text, terminated: false });
				}
				const { bytesRead } = await this.file.read(this.chunk, 0, this.chunk.length, this.byteOffset);
				const abortAfterRead = aborted<TextLine | undefined>(options, this.path);
				if (abortAfterRead) return abortAfterRead;
				this.byteOffset += bytesRead;
				if (bytesRead === 0) {
					this.buffered += this.decoder.decode();
					this.ended = true;
				} else {
					this.buffered += this.decoder.decode(this.chunk.subarray(0, bytesRead), { stream: true });
				}
			}
		} catch (error) {
			return err(toFileError(error, this.path));
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.buffered = "";
		try {
			await this.file.close();
		} catch {
			// Best-effort, including after a cancellation or an earlier I/O failure.
		}
	}
}

/** The filesystem half of the local execution environment. */
export class NodeFileSystem implements FileSystem {
	cwd: string;

	constructor(options: { cwd?: string } = {}) {
		this.cwd = options.cwd ?? process.cwd();
	}

	async absolutePath(path: string, options?: EnvCallOptions): Promise<Result<string, FileError>> {
		const alreadyAborted = aborted<string>(options);
		if (alreadyAborted) return alreadyAborted;
		return ok(resolveEnvPath(this.cwd, path));
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(join(...parts));
	}

	async readTextFile(path: string, options?: EnvCallOptions): Promise<Result<string, FileError>> {
		const resolved = resolveEnvPath(this.cwd, path);
		const signal = options?.signal;
		const alreadyAborted = aborted<string>(options, resolved);
		if (alreadyAborted) return alreadyAborted;
		try {
			return ok(await readFile(resolved, { encoding: "utf8", ...(signal === undefined ? {} : { signal }) }));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async openTextLineReader(path: string, options?: EnvCallOptions): Promise<Result<TextLineReader, FileError>> {
		const resolved = resolveEnvPath(this.cwd, path);
		const alreadyAborted = aborted<TextLineReader>(options, resolved);
		if (alreadyAborted) return alreadyAborted;
		try {
			const file = await openFile(resolved, "r");
			const abortAfterOpen = aborted<TextLineReader>(options, resolved);
			if (abortAfterOpen) {
				await file.close().catch(() => undefined);
				return abortAfterOpen;
			}
			return ok(new NodeTextLineReader(file, resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async readTextLines(
		path: string,
		options?: EnvCallOptions & { maxLines?: number },
	): Promise<Result<string[], FileError>> {
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		const opened = await this.openTextLineReader(path, options);
		if (!opened.ok) return opened;
		const lines: string[] = [];
		try {
			while (options?.maxLines === undefined || lines.length < options.maxLines) {
				const line = await opened.value.readLine(options);
				if (!line.ok) return line;
				if (line.value === undefined) break;
				lines.push(line.value.text);
			}
			return ok(lines);
		} finally {
			await opened.value.close();
		}
	}

	async readBinaryFile(path: string, options?: EnvCallOptions): Promise<Result<Uint8Array, FileError>> {
		const resolved = resolveEnvPath(this.cwd, path);
		const signal = options?.signal;
		const alreadyAborted = aborted<Uint8Array>(options, resolved);
		if (alreadyAborted) return alreadyAborted;
		try {
			return ok(await readFile(resolved, { ...(signal === undefined ? {} : { signal }) }));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async writeFile(
		path: string,
		content: string | Uint8Array,
		options?: EnvCallOptions,
	): Promise<Result<void, FileError>> {
		const resolved = resolveEnvPath(this.cwd, path);
		const signal = options?.signal;
		const alreadyAborted = aborted<void>(options, resolved);
		if (alreadyAborted) return alreadyAborted;
		try {
			await mkdir(resolve(resolved, ".."), { recursive: true });
			const abortAfterMkdir = aborted<void>(options, resolved);
			if (abortAfterMkdir) return abortAfterMkdir;
			await writeFile(resolved, content, { ...(signal === undefined ? {} : { signal }) });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async appendFile(
		path: string,
		content: string | Uint8Array,
		options?: EnvCallOptions,
	): Promise<Result<void, FileError>> {
		const resolved = resolveEnvPath(this.cwd, path);
		const alreadyAborted = aborted<void>(options, resolved);
		if (alreadyAborted) return alreadyAborted;
		try {
			await mkdir(resolve(resolved, ".."), { recursive: true });
			const abortAfterMkdir = aborted<void>(options, resolved);
			if (abortAfterMkdir) return abortAfterMkdir;
			await appendFile(resolved, content);
			return aborted<void>(options, resolved) ?? ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async renameFile(source: string, destination: string, options?: EnvCallOptions): Promise<Result<void, FileError>> {
		const from = resolveEnvPath(this.cwd, source);
		const to = resolveEnvPath(this.cwd, destination);
		const alreadyAborted = aborted<void>(options, to);
		if (alreadyAborted) return alreadyAborted;
		try {
			await rename(from, to);
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, from));
		}
	}

	async fileInfo(path: string, options?: EnvCallOptions): Promise<Result<FileInfo, FileError>> {
		const resolved = resolveEnvPath(this.cwd, path);
		const alreadyAborted = aborted<FileInfo>(options, resolved);
		if (alreadyAborted) return alreadyAborted;
		try {
			return infoOf(resolved, await lstat(resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async listDir(path: string, options?: EnvCallOptions): Promise<Result<FileInfo[], FileError>> {
		const resolved = resolveEnvPath(this.cwd, path);
		const alreadyAborted = aborted<FileInfo[]>(options, resolved);
		if (alreadyAborted) return alreadyAborted;
		try {
			const entries = await readdir(resolved, { withFileTypes: true });
			const infos: FileInfo[] = [];
			for (const entry of entries) {
				const abortInLoop = aborted<FileInfo[]>(options, resolved);
				if (abortInLoop) return abortInLoop;
				const entryPath = resolve(resolved, entry.name);
				try {
					const info = infoOf(entryPath, await lstat(entryPath));
					if (info.ok) infos.push(info.value);
				} catch (error) {
					return err(toFileError(error, entryPath));
				}
			}
			return ok(infos);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async canonicalPath(path: string, options?: EnvCallOptions): Promise<Result<string, FileError>> {
		const resolved = resolveEnvPath(this.cwd, path);
		const alreadyAborted = aborted<string>(options, resolved);
		if (alreadyAborted) return alreadyAborted;
		try {
			return ok(await realpath(resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async exists(path: string, options?: EnvCallOptions): Promise<Result<boolean, FileError>> {
		const result = await this.fileInfo(path, options);
		if (result.ok) return ok(true);
		if (result.error.code === "not_found") return ok(false);
		return err(result.error);
	}

	async createDir(path: string, options?: EnvCallOptions & { recursive?: boolean }): Promise<Result<void, FileError>> {
		const resolved = resolveEnvPath(this.cwd, path);
		const alreadyAborted = aborted<void>(options, resolved);
		if (alreadyAborted) return alreadyAborted;
		try {
			await mkdir(resolved, { recursive: options?.recursive ?? true });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async remove(
		path: string,
		options?: EnvCallOptions & { recursive?: boolean; force?: boolean },
	): Promise<Result<void, FileError>> {
		const resolved = resolveEnvPath(this.cwd, path);
		const alreadyAborted = aborted<void>(options, resolved);
		if (alreadyAborted) return alreadyAborted;
		try {
			await rm(resolved, { recursive: options?.recursive ?? false, force: options?.force ?? false });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async createTempDir(prefix = "tmp-", options?: EnvCallOptions): Promise<Result<string, FileError>> {
		const alreadyAborted = aborted<string>(options);
		if (alreadyAborted) return alreadyAborted;
		try {
			return ok(await mkdtemp(join(tmpdir(), prefix)));
		} catch (error) {
			return err(toFileError(error));
		}
	}

	async createTempFile(
		options?: EnvCallOptions & { prefix?: string; suffix?: string },
	): Promise<Result<string, FileError>> {
		const dir = await this.createTempDir("tmp-", options);
		if (!dir.ok) return dir;
		const path = join(dir.value, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
		try {
			await writeFile(path, "");
			return ok(path);
		} catch (error) {
			return err(toFileError(error, path));
		}
	}

	async cleanup(): Promise<void> {
		// Nothing held open: every handle is closed by the call that opened it.
	}
}

/** Whether a path is reachable, used by callers that only need a yes or no. */
export async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}
