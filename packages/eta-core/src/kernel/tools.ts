/**
 * ToolService — the tool seam (REFACTOR.md §2.2).
 *
 * Plugins register tools here; the runner reads the current set every turn,
 * so hot registration/unregistration never disturbs a running turn. A
 * middleware chain stands between the runner and execution: `before` can
 * observe, rewrite arguments, or block a call; `after` can observe or rewrite
 * the result. This is the replacement for pi's before/after_tool_call hooks.
 *
 * The registry is deliberately unconstrained about tool shape (eta-agent
 * lesson: harness tool types with extra required fields must fit here); a
 * tool is anything with a name and an execute function.
 */

import type { Context } from "cordis";
import { Service } from "cordis";
import type { ToolExecution } from "../types/config.ts";

/** The minimal tool shape the seam requires. Plugin tools may carry more. */
export interface KernelTool<TArgs = unknown, TResult = unknown> {
	name: string;
	description?: string;
	execute(args: TArgs, call: ToolCallInfo): TResult | Promise<TResult>;
}

/** What the runner knows about a call when it asks the middleware chain. */
export interface ToolCallInfo {
	turn: number;
	toolCallId: string;
}

export type BeforeToolResult = { ok: true; args: unknown } | { ok: false; blockReason: string };

export interface ToolMiddleware {
	name: string;
	/** Runs outermost-to-innermost; the last write wins per field. */
	before?: (name: string, args: unknown, call: ToolCallInfo) => BeforeToolResult | Promise<BeforeToolResult>;
	/** Runs innermost-to-outermost on the way back. */
	after?: (name: string, args: unknown, result: unknown, call: ToolCallInfo) => unknown | Promise<unknown>;
}

/** Whether an error is the run being cancelled rather than a tool failing. */
export function isAbortError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	return (error as { name?: string }).name === "AbortError";
}

export class ToolService extends Service {
	static readonly provide = "tools";

	private tools = new Map<string, KernelTool>();
	private middlewares: ToolMiddleware[] = [];

	constructor(ctx: Context) {
		super(ctx, "tools");
	}

	/** Register or replace a tool. Returns an unregister function. */
	register(tool: KernelTool): () => void {
		this.tools.set(tool.name, tool);
		return () => {
			// Only unregister if it is still the same tool (no clobber on re-register).
			if (this.tools.get(tool.name) === tool) this.tools.delete(tool.name);
		};
	}

	unregister(name: string): boolean {
		return this.tools.delete(name);
	}

	get(name: string): KernelTool | undefined {
		return this.tools.get(name);
	}

	/** The set the runner hands to the provider this turn. */
	list(): KernelTool[] {
		return [...this.tools.values()];
	}

	names(): string[] {
		return [...this.tools.keys()];
	}

	/** Append a middleware layer; returns a detach function. */
	use(middleware: ToolMiddleware): () => void {
		this.middlewares.push(middleware);
		return () => {
			const i = this.middlewares.indexOf(middleware);
			if (i >= 0) this.middlewares.splice(i, 1);
		};
	}

	/**
	 * Execute a batch of calls the way the session is configured (eta-agent's
	 * runSequential/runParallel). Results always come back in call order, so the
	 * transcript reads the same either way; parallel only changes when the work
	 * happens, never what order it is recorded in.
	 */
	async executeBatch(
		calls: readonly { id: string; name: string; arguments: unknown }[],
		options: { execution: ToolExecution; turn: number },
	): Promise<{ id: string; result: unknown }[]> {
		const run = (call: { id: string; name: string; arguments: unknown }) =>
			this.execute(call.name, call.arguments, { turn: options.turn, toolCallId: call.id });
		if (options.execution === "sequential") {
			const results: { id: string; result: unknown }[] = [];
			for (const call of calls) results.push({ id: call.id, result: await run(call) });
			return results;
		}
		const settled = await Promise.all(calls.map(run));
		return calls.map((call, index) => ({ id: call.id, result: settled[index] }));
	}

	/** Execute a call through the full chain: before (outer→inner) → tool → after (inner→outer). */
	async execute(name: string, args: unknown, call: ToolCallInfo): Promise<unknown> {
		const tool = this.tools.get(name);
		if (tool === undefined) {
			return { isError: true, content: `unknown tool: ${name}` };
		}
		let currentArgs = args;
		for (const m of this.middlewares) {
			if (m.before === undefined) continue;
			const verdict = await m.before(name, currentArgs, call);
			if (!verdict.ok) return { isError: true, content: `blocked by ${m.name}: ${verdict.blockReason}` };
			currentArgs = verdict.args;
		}
		let result: unknown;
		try {
			result = await tool.execute(currentArgs, call);
		} catch (error) {
			// An abort is not a tool outcome — it stops the run. Everything else a
			// tool throws is a result the model has to read (eta-agent's
			// executeToolCall converts the same way).
			if (isAbortError(error)) throw error;
			return { isError: true, content: error instanceof Error ? error.message : String(error) };
		}
		for (const m of [...this.middlewares].reverse()) {
			if (m.after === undefined) continue;
			result = await m.after(name, currentArgs, result, call);
		}
		return result;
	}
}
