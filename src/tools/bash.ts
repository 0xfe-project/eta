/**
 * bash — the shell (port of eta-agent's `tools/bash.ts`).
 *
 * What the model gets back is what a terminal shows: stdout and stderr
 * interleaved in arrival order, with the tail kept when the output is longer
 * than the budget, and a note saying which lines those were and where the whole
 * output went. The full output is spilled to a temp file whenever it is cut, so
 * "read the rest" is a `read` away.
 *
 * Three endings, told apart on purpose:
 * - exit 0: the output;
 * - a non-zero exit: the output plus `Command exited with code N` — an error
 *   result, so a model cannot read a failure as success;
 * - a timeout or an abort: the output so far plus why it stopped.
 *
 * A host may inject `commandPrefix` (a preamble line) and `prepare` (to change
 * the command, cwd, or environment before it runs) — that is how a remote
 * backend says "run this over there" without this tool knowing.
 *
 * Not ported yet: eta-agent streams a rate-limited live view of the output into
 * the running tool call (`tool:update` while the command talks). That needs the
 * adaptive publisher to be respectable; it is tracked as its own slice rather
 * than faked here.
 */
import type { Static } from "typebox";
import { Type } from "typebox";
import type { EnvCallOptions, ShellTruncation } from "../env/types";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "../truncate";
import type { ExecutionToolContext } from "./context";
import type { HarnessTool, ToolResult } from "./tool";

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

export const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: ShellTruncation | undefined;
	fullOutputPath?: string | undefined;
}

/** What a command is about to be run as; a host may change it in `prepare`. */
export interface BashExecution {
	command: string;
	cwd: string;
	env: Record<string, string>;
	inheritEnv: boolean;
}

export type BashPrepare<TContext extends ExecutionToolContext = ExecutionToolContext> = (
	execution: BashExecution,
	toolContext: TContext,
) => void | Promise<void>;

export interface BashToolOptions<TContext extends ExecutionToolContext = ExecutionToolContext> {
	/** A line prepended to every command (a shell hook, a remote preamble). */
	commandPrefix?: string | undefined;
	/** Called before the command runs: the place to set cwd, env, or rewrite it. */
	prepare?: BashPrepare<TContext> | undefined;
}

function validateTimeout(timeout: number | undefined): void {
	if (timeout === undefined) return;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	if (timeout > MAX_TIMEOUT_SECONDS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
}

/** The notice appended to a cut output, naming what was kept and where the rest is. */
function truncationNotice(truncation: ShellTruncation, spillPath: string | undefined): string {
	const startLine = truncation.totalLines - truncation.outputLines + 1;
	const endLine = truncation.totalLines;
	if (truncation.lastLinePartial) {
		const lastLineSize = formatSize(truncation.lastLineBytes ?? truncation.outputBytes);
		return `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${spillPath}]`;
	}
	if (truncation.truncatedBy === "lines") {
		return `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${spillPath}]`;
	}
	return `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${spillPath}]`;
}

export function createBashTool<TContext extends ExecutionToolContext = ExecutionToolContext>(
	options: BashToolOptions<TContext> = {},
): HarnessTool<TContext, typeof bashSchema, BashToolDetails | undefined> {
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns combined stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		parameters: bashSchema,
		async execute(args, run): Promise<ToolResult<BashToolDetails | undefined>> {
			validateTimeout(args.timeout);
			const env = run.context.env;
			const execution: BashExecution = {
				command: options.commandPrefix === undefined ? args.command : `${options.commandPrefix}\n${args.command}`,
				cwd: env.cwd,
				env: {},
				inheritEnv: true,
			};
			await options.prepare?.(execution, run.context);

			const call: EnvCallOptions = run.call.signal === undefined ? {} : { signal: run.call.signal };
			const result = await env.exec(execution.command, {
				cwd: execution.cwd,
				env: execution.env,
				inheritEnv: execution.inheritEnv,
				...(args.timeout === undefined ? {} : { timeout: args.timeout }),
				limits: { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES, retain: "tail" },
				spill: true,
				...call,
			});

			if (!result.ok) {
				// Whatever the command printed before it was killed, then why.
				const text = result.error.output ?? "";
				const status =
					result.error.code === "timeout"
						? `Command timed out after ${args.timeout} seconds`
						: result.error.code === "aborted"
							? "Command aborted"
							: result.error.message;
				throw new Error(text.length > 0 ? `${text}\n\n${status}` : status, { cause: result.error });
			}

			let outputText = result.value.output ?? "";
			let details: BashToolDetails | undefined;
			if (result.value.truncation?.truncated === true) {
				details = { truncation: result.value.truncation, fullOutputPath: result.value.spillPath };
				outputText += truncationNotice(result.value.truncation, result.value.spillPath);
			}
			if (result.value.exitCode !== 0) {
				throw new Error(
					`${outputText.length > 0 ? `${outputText}\n\n` : ""}Command exited with code ${result.value.exitCode}`,
				);
			}
			return { content: [{ type: "text", text: outputText || "(no output)" }], details };
		},
	};
}
