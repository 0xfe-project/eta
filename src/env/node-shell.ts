/**
 * NodeShell — the local backend's shell half (port of eta-agent's
 * `harness/env/nodejs.ts`, shell side).
 *
 * A command runs through bash: `spawn(shell, ["-c", command])`, detached on
 * POSIX so the whole process tree can be killed, with stdin closed (unless the
 * shell is the legacy WSL stub, which wants the command on stdin). Shell
 * resolution follows eta-agent: an explicit path wins, then Git Bash on Windows
 * (Program Files, then PATH), then `/bin/bash`, then whatever bash is on PATH,
 * then plain `sh`.
 *
 * Three ways a command ends, and they are not the same thing:
 * - it exits: a result with the code, whatever it is (`exitCode: 3` is not an
 *   error — the tool reports it);
 * - it exceeds its timeout: an `ExecutionError("timeout")`;
 * - the run is aborted: an `ExecutionError("aborted")`.
 * The last two kill the process tree, so a shell cannot leave orphans behind.
 *
 * Output arrives as two streams and stays two: `stdout` and `stderr` are
 * captured separately, and the exit is only reported once both streams have
 * ended (with a short grace period for a child that dies before its pipes
 * drain). Bounding what is kept — and spilling the rest to a file — is the
 * truncation slice, which this shares with `read`.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import { LiveOutput, OutputBuffer } from "../output-capture";
import { NodeFileSystem, pathExists, resolveEnvPath } from "./node-fs";
import {
	type EnvCallOptions,
	type ExecutionEnv,
	type ExecutionError,
	ExecutionError as ExecutionErrorClass,
	err,
	type FileSystem,
	ok,
	type Result,
	type Shell,
	type ShellExecOptions,
	type ShellExecResult,
} from "./types";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
/** How long to wait for the pipes to drain after the process has exited. */
const EXIT_STDIO_GRACE_MS = 100;

/** Seconds to milliseconds, refusing nonsense before a process is started. */
export function resolveTimeoutMs(timeout: number | undefined): Result<number | undefined, ExecutionError> {
	if (timeout === undefined) return ok(undefined);
	if (!Number.isFinite(timeout) || timeout <= 0) {
		return err(new ExecutionErrorClass("timeout", "Invalid timeout: must be a finite number of seconds"));
	}
	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		return err(new ExecutionErrorClass("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`));
	}
	return ok(timeoutMs);
}

/** Kill a process and everything it started. */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			const child = spawn(
				join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(pid)],
				{ stdio: "ignore", detached: true, windowsHide: true },
			);
			// A failed spawn reports asynchronously; consume it so Node does not crash.
			child.once("error", () => undefined);
		} catch {
			// Nothing else to try.
		}
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already dead.
		}
	}
}

interface ShellConfig {
	shell: string;
	args: string[];
	/** The legacy WSL stub takes the command on stdin; everything else on argv. */
	commandTransport?: "argv" | "stdin";
}

function isLegacyWslBashPath(path: string): boolean {
	const normalized = path.replace(/\//g, "\\").toLowerCase();
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function bashConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

async function runToCompletion(command: string, args: string[]): Promise<{ stdout: string; status: number | null }> {
	return await new Promise((resolvePromise) => {
		let stdout = "";
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
		} catch {
			resolvePromise({ stdout: "", status: null });
			return;
		}
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", () => resolvePromise({ stdout: "", status: null }));
		child.on("close", (status) => resolvePromise({ stdout, status }));
	});
}

async function findBashOnPath(): Promise<string | null> {
	const result =
		process.platform === "win32"
			? await runToCompletion("where", ["bash.exe"])
			: await runToCompletion("which", ["bash"]);
	if (result.status !== 0 || result.stdout.length === 0) return null;
	const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
	return firstMatch !== undefined && (await pathExists(firstMatch)) ? firstMatch : null;
}

/** Which shell to run commands with. */
export async function resolveShellConfig(customShellPath?: string): Promise<Result<ShellConfig, ExecutionError>> {
	if (customShellPath !== undefined) {
		if (await pathExists(customShellPath)) return ok(bashConfig(customShellPath));
		return err(new ExecutionErrorClass("shell_unavailable", `Custom shell path not found: ${customShellPath}`));
	}
	if (process.platform === "win32") {
		const candidates: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles !== undefined) candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86 !== undefined) candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		for (const candidate of candidates) {
			if (await pathExists(candidate)) return ok(bashConfig(candidate));
		}
		const onPath = await findBashOnPath();
		if (onPath !== null) return ok(bashConfig(onPath));
		return err(
			new ExecutionErrorClass(
				"shell_unavailable",
				"No bash shell found. Install Git for Windows, put a bash on PATH, or configure an explicit shellPath.",
			),
		);
	}
	if (await pathExists("/bin/bash")) return ok(bashConfig("/bin/bash"));
	const onPath = await findBashOnPath();
	if (onPath !== null) return ok(bashConfig(onPath));
	return ok({ shell: "sh", args: ["-c"] });
}

function shellEnv(
	base: NodeJS.ProcessEnv | undefined,
	extra: Record<string, string> | undefined,
	inherit: boolean | undefined,
): NodeJS.ProcessEnv {
	if (inherit === false) return { ...extra };
	return { ...process.env, ...base, ...extra };
}

/**
 * Wait for a child to exit *and* for its pipes to finish, which is not the same
 * moment: a process can exit with output still in flight. Waiting for both is
 * what keeps a command's last line from being lost.
 */
function waitForChildProcess(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolvePromise, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let exitSignal: NodeJS.Signals | null = null;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		const cleanup = (): void => {
			if (graceTimer !== undefined) clearTimeout(graceTimer);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};
		const finalize = (): void => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolvePromise({ code: exitCode, signal: exitSignal });
		};
		const maybeFinalize = (): void => {
			if (exited && stdoutEnded && stderrEnded) finalize();
		};
		const armGrace = (): void => {
			if (graceTimer !== undefined) clearTimeout(graceTimer);
			graceTimer = setTimeout(finalize, EXIT_STDIO_GRACE_MS);
		};
		const onData = (): void => {
			if (exited && !settled) armGrace();
		};
		const onStdoutEnd = (): void => {
			stdoutEnded = true;
			maybeFinalize();
		};
		const onStderrEnd = (): void => {
			stderrEnded = true;
			maybeFinalize();
		};
		const onError = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
			exited = true;
			exitCode = code;
			exitSignal = signal;
			maybeFinalize();
			if (!settled) armGrace();
		};
		const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
			exitCode = code;
			exitSignal = signal;
			finalize();
		};

		child.stdout?.on("end", onStdoutEnd);
		child.stderr?.on("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}

/** The shell half of the local execution environment. */
export class NodeShell implements Shell {
	private readonly cwdProvider: () => string;
	private readonly shellPath: string | undefined;
	private readonly shellEnvBase: NodeJS.ProcessEnv | undefined;
	/** Where a spilled output goes. Without one, `spill` is ignored. */
	private readonly fileSystem: FileSystem | undefined;
	private readonly activeChildPids = new Set<number>();

	constructor(options: {
		cwd: string | (() => string);
		shellPath?: string;
		shellEnv?: NodeJS.ProcessEnv;
		fileSystem?: FileSystem;
	}) {
		this.cwdProvider = typeof options.cwd === "function" ? options.cwd : () => options.cwd as string;
		this.shellPath = options.shellPath;
		this.shellEnvBase = options.shellEnv;
		this.fileSystem = options.fileSystem;
	}

	async exec(command: string, options?: ShellExecOptions): Promise<Result<ShellExecResult, ExecutionError>> {
		const signal = options?.signal;
		if (signal?.aborted === true) return err(new ExecutionErrorClass("aborted", "the command was aborted"));
		const timeoutMsResult = resolveTimeoutMs(options?.timeout);
		if (!timeoutMsResult.ok) return err(timeoutMsResult.error);
		const timeoutMs = timeoutMsResult.value;

		const cwd = options?.cwd === undefined ? this.cwdProvider() : resolveEnvPath(this.cwdProvider(), options.cwd);
		const shellConfig = await resolveShellConfig(this.shellPath);
		if (!shellConfig.ok) return shellConfig;
		try {
			await access(cwd, constants.F_OK);
		} catch (error) {
			return err(
				new ExecutionErrorClass(
					"spawn_error",
					`working directory does not exist: ${cwd}`,
					error instanceof Error ? error : undefined,
				),
			);
		}

		return await new Promise<Result<ShellExecResult, ExecutionError>>((resolvePromise) => {
			let settled = false;
			let timedOut = false;
			let child: ReturnType<typeof spawn> | undefined;
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			// Bounded capture: what the model sees is cut before it is ever
			// concatenated, so a chatty command cannot grow the transcript's memory.
			const limits = options?.limits;
			const wantsSpill = options?.spill === true && this.fileSystem !== undefined;
			const bounded =
				limits === undefined
					? undefined
					: () =>
							new OutputBuffer({
								maxBytes: limits.maxBytes,
								maxLines: limits.maxLines,
								retain: limits.retain === "head" ? "head" : "tail",
							});
			const combined = bounded?.();
			const stdoutBuffer = bounded?.();
			const stderrBuffer = bounded?.();
			// The live view: the same combined window, published as it fills. Only a
			// caller that asked for updates and a bounded window gets one — there is
			// nothing to publish otherwise.
			const live =
				combined === undefined || options?.onUpdate === undefined
					? undefined
					: new LiveOutput({
							buffer: combined,
							onUpdate: options.onUpdate,
							onError: () => undefined,
						});
			// Without limits the caller asked for the whole truth, so it is kept whole.
			let stdout = "";
			let stderr = "";
			const toSpill = this.fileSystem;
			let spillPath: string | undefined;
			let spillPrefix = "";
			let spilling = false;
			let spillWrites: Promise<void> = Promise.resolve();
			const spillChunk = (text: string): void => {
				const fileSystem = toSpill;
				const path = spillPath;
				if (fileSystem === undefined || path === undefined) return;
				spillWrites = spillWrites.then(async () => {
					await fileSystem.appendFile(path, text);
				});
			};
			const startSpill = (): void => {
				const fileSystem = toSpill;
				if (spilling || fileSystem === undefined) return;
				spilling = true;
				const prefix = spillPrefix;
				spillPrefix = "";
				spillWrites = spillWrites.then(async () => {
					const created = await fileSystem.createTempFile({ prefix: "eta-output-", suffix: ".log" });
					if (!created.ok) return;
					spillPath = created.value;
					await fileSystem.writeFile(created.value, prefix);
					// The window now has a second home: say so, now, rather than at the
					// next chunk (a command can go quiet right after it floods).
					live?.setSpillPath(created.value);
				});
			};

			const onAbort = (): void => {
				if (child?.pid !== undefined) killProcessTree(child.pid);
			};
			const settle = (result: Result<ShellExecResult, ExecutionError>): void => {
				if (settled) return;
				settled = true;
				if (timeoutId !== undefined) clearTimeout(timeoutId);
				signal?.removeEventListener("abort", onAbort);
				if (child?.pid !== undefined) this.activeChildPids.delete(child.pid);
				resolvePromise(result);
			};

			try {
				const fromStdin = shellConfig.value.commandTransport === "stdin";
				child = spawn(
					shellConfig.value.shell,
					fromStdin ? shellConfig.value.args : [...shellConfig.value.args, command],
					{
						cwd,
						detached: process.platform !== "win32",
						env: shellEnv(this.shellEnvBase, options?.env, options?.inheritEnv),
						stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
						windowsHide: true,
					},
				);
				if (child.pid !== undefined) this.activeChildPids.add(child.pid);
				if (fromStdin) {
					child.stdin?.on("error", () => undefined);
					child.stdin?.end(command);
				}
			} catch (error) {
				settle(
					err(
						new ExecutionErrorClass(
							"spawn_error",
							error instanceof Error ? error.message : String(error),
							error as Error,
						),
					),
				);
				return;
			}

			timeoutId =
				timeoutMs === undefined
					? undefined
					: setTimeout(() => {
							timedOut = true;
							onAbort();
						}, timeoutMs);
			if (signal !== undefined) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}

			child.stdout?.setEncoding("utf8");
			child.stderr?.setEncoding("utf8");
			const feed = (chunk: string, stream: "stdout" | "stderr"): void => {
				if (combined === undefined) {
					if (stream === "stdout") stdout += chunk;
					else stderr += chunk;
				} else if (live === undefined) {
					combined.push(chunk);
					if (stream === "stdout") stdoutBuffer?.push(chunk);
					else stderrBuffer?.push(chunk);
				} else {
					// One push through the live view, which is what feeds the combined
					// window; the per-stream buffers are only needed for the final split.
					live.push(chunk);
					if (stream === "stdout") stdoutBuffer?.push(chunk);
					else stderrBuffer?.push(chunk);
				}
				if (!wantsSpill) return;
				if (spilling) {
					spillChunk(chunk);
					return;
				}
				spillPrefix += chunk;
				if (combined?.truncated === true) startSpill();
			};
			child.stdout?.on("data", (chunk: string) => feed(chunk, "stdout"));
			child.stderr?.on("data", (chunk: string) => feed(chunk, "stderr"));

			void waitForChildProcess(child).then(
				async ({ code, signal: exitSignal }) => {
					// The last frame is the one that matters: a view cut by the rate limit
					// would leave a client showing less than the command printed.
					live?.finish();
					combined?.finish();
					stdoutBuffer?.finish();
					stderrBuffer?.finish();
					await spillWrites;
					// What was printed before the kill is still worth reporting: a
					// command that times out has usually said something first.
					const partial = combined?.snapshot().text;
					if (timedOut) {
						settle(err(new ExecutionErrorClass("timeout", `timeout:${options?.timeout}`, undefined, partial)));
						return;
					}
					if (signal?.aborted === true) {
						settle(err(new ExecutionErrorClass("aborted", "the command was aborted", undefined, partial)));
						return;
					}
					// A process killed by a signal has no exit code; 128 + signal is the
					// conventional reading, so nobody mistakes it for a clean exit.
					const exitCode = code ?? (exitSignal !== null ? 128 + (osConstants.signals[exitSignal] ?? 0) : 1);
					const boundedOutput = combined?.snapshot();
					settle(
						ok({
							exitCode,
							stdout: stdoutBuffer?.snapshot().text ?? stdout,
							stderr: stderrBuffer?.snapshot().text ?? stderr,
							...(boundedOutput === undefined
								? {}
								: { output: boundedOutput.text, truncation: boundedOutput.truncation }),
							...(spillPath === undefined ? {} : { spillPath }),
						}),
					);
				},
				(error: Error) => settle(err(new ExecutionErrorClass("spawn_error", error.message, error))),
			);
		});
	}

	async cleanup(): Promise<void> {
		for (const pid of this.activeChildPids) killProcessTree(pid);
		this.activeChildPids.clear();
	}
}

/**
 * The local execution environment: the filesystem and the shell over the same
 * working directory.
 */
export class NodeEnvironment extends NodeFileSystem implements ExecutionEnv {
	private readonly shell: NodeShell;

	constructor(options: { cwd?: string; shellPath?: string; shellEnv?: NodeJS.ProcessEnv } = {}) {
		super(options);
		this.shell = new NodeShell({
			cwd: () => this.cwd,
			fileSystem: this,
			...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
			...(options.shellEnv === undefined ? {} : { shellEnv: options.shellEnv }),
		});
	}

	exec(
		command: string,
		options?: ShellExecOptions & EnvCallOptions,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		return this.shell.exec(command, options);
	}

	override async cleanup(): Promise<void> {
		await this.shell.cleanup();
		await super.cleanup();
	}
}
