/**
 * What the built-in execution tools are handed: an environment.
 *
 * A port of eta-agent's `tools/tool-context.ts`. The kernel knows this only as
 * an opaque `toolContext`; the harness decides that its tools get a filesystem
 * and a shell, and a plugin can put more in a context of its own.
 */
import type { ExecutionEnv } from "../env/types";

/** Filesystem and shell for the built-in execution tools. */
export interface ExecutionToolContext {
	env: ExecutionEnv;
}

/** The context of an execution tool, or a loud failure naming what is missing. */
export function executionContext(toolContext: unknown): ExecutionToolContext {
	if (
		typeof toolContext !== "object" ||
		toolContext === null ||
		typeof (toolContext as { env?: unknown }).env !== "object" ||
		(toolContext as { env?: unknown }).env === null
	) {
		throw new Error(
			"this tool needs an execution environment: pass { env } as the runner's toolContext (see @eta/harness's ExecutionToolContext)",
		);
	}
	return toolContext as ExecutionToolContext;
}
