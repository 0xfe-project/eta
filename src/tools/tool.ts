/**
 * Harness tools (REFACTOR.md §6.2).
 *
 * The kernel's tool surface is deliberately minimal: a name, a description, an
 * `execute`, and whatever the host puts in `toolContext`. What a real tool needs
 * is a little more — a parameter schema for the provider to see, validated
 * arguments before anything runs, a typed context (the execution environment),
 * and a result that can carry images as well as text.
 *
 * `defineTool` is that layer, and it is the only way the built-in tools are
 * written. Validation is fail-closed: bad arguments come back to the model as a
 * readable error result, and the tool body never runs on them.
 */
import type { ImageContent, KernelTool, TextContent, ToolCallInfo } from "@eta/core";
import type { Static, TSchema } from "typebox";
import { Compile } from "typebox/compile";

/** What a tool answers with: content blocks, and optionally details for the host. */
export interface ToolResult<TDetails = unknown> {
	content: (TextContent | ImageContent)[];
	details?: TDetails | undefined;
	isError?: boolean | undefined;
	/** A tool that ends the run (the loop stops after adopting its result). */
	terminate?: boolean | undefined;
}

/** What a tool is handed when it runs. */
export interface ToolRun<TContext> {
	/** The kernel's call facts: id, turn, the run's abort signal. */
	call: ToolCallInfo;
	/** The context this run resolved for tools (`ExecutionToolContext` for the built-ins). */
	context: TContext;
	/** Report progress; only accepted while the call is still running. */
	update: (partial: ToolResult, options?: { checkpoint?: boolean }) => void;
}

/** A tool as the harness writes it. */
export interface HarnessTool<TContext, TParameters extends TSchema = TSchema, TDetails = unknown> {
	name: string;
	/** The name a UI shows; defaults to {@link name}. */
	label?: string | undefined;
	description: string;
	parameters: TParameters;
	/**
	 * Normalize what the model sent before it is validated — a JSON string where
	 * an array belongs, a single object where a list belongs, a legacy field name.
	 * Models send what they send; the tool absorbs it or says why it cannot.
	 */
	prepareArguments?: ((args: unknown) => unknown) | undefined;
	execute(args: Static<TParameters>, run: ToolRun<TContext>): Promise<ToolResult<TDetails>> | ToolResult<TDetails>;
}

/** Build a harness tool. */
export function defineTool<TContext, TParameters extends TSchema, TDetails = unknown>(
	tool: HarnessTool<TContext, TParameters, TDetails>,
): HarnessTool<TContext, TParameters, TDetails> {
	return tool;
}

/** Text-only result. */
export function text<TDetails = undefined>(content: string, details?: TDetails): ToolResult<TDetails> {
	return {
		content: [{ type: "text", text: content }],
		...(details === undefined ? {} : { details }),
	} as ToolResult<TDetails>;
}

/** A result the model should read as a failure. */
export function toolError(message: string): ToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Adapt a harness tool into the kernel's tool shape.
 *
 * `contextOf` turns whatever the run put in `toolContext` into this tool's
 * context; a tool that needs one and finds none fails loudly rather than
 * running against `undefined`.
 */
export function toKernelTool<TContext, TParameters extends TSchema, TDetails>(
	tool: HarnessTool<TContext, TParameters, TDetails>,
	contextOf: (toolContext: unknown) => TContext,
): KernelTool<Static<TParameters>, ToolResult<TDetails>> & { parameters: TParameters } {
	// Compiled once per tool: the validator is what makes a checked call cheap
	// enough to do on every one of them.
	const validator = Compile(tool.parameters);
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		async execute(rawArgs: unknown, call: ToolCallInfo): Promise<ToolResult<TDetails>> {
			const args = tool.prepareArguments === undefined ? rawArgs : tool.prepareArguments(rawArgs);
			if (!validator.Check(args)) {
				const problems = validator
					.Errors(args)
					.slice(0, 3)
					.map((error) => `${error.instancePath.length === 0 ? "arguments" : error.instancePath} ${error.message}`)
					.join("; ");
				return toolError(`invalid arguments for ${tool.name}: ${problems}`) as ToolResult<TDetails>;
			}
			const context = contextOf(call.toolContext);
			return await tool.execute(args as Static<TParameters>, {
				call,
				context,
				update: (partial: ToolResult, options?: { checkpoint?: boolean }) => call.update?.(partial, options),
			});
		},
	};
}

/** Adapt several tools at once. */
export function toKernelTools<TContext>(
	tools: readonly HarnessTool<TContext, TSchema, unknown>[],
	contextOf: (toolContext: unknown) => TContext,
): (KernelTool<unknown, ToolResult<unknown>> & { parameters: TSchema })[] {
	return tools.map((tool) => toKernelTool(tool, contextOf));
}
