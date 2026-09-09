import type { AgentHarness } from "../harness/agent-harness.ts";

import type { DevEmit, DevEventBus } from "./dev-events.ts";

export interface DevBridgeHandle {
	emit: DevEmit;
	detach(): void;
}

/**
 * Mirrors harness lifecycle onto the dev stream so turn/usage/prompt/tool/
 * retry/compaction are observable without touching the drive. Batteries emit
 * their own categories straight onto the bus.
 */
export function createDevBridge(harness: AgentHarness, bus: DevEventBus): DevBridgeHandle {
	const emit = bus.emit;
	const offs: (() => void)[] = [];
	const on = (name: Parameters<AgentHarness["hooks"]["on"]>[0], handler: (...args: never[]) => void) => {
		offs.push(harness.hooks.on(name, handler as never, { id: `eta.dev.${name}` }));
	};
	emit("lifecycle", "attach");
	on("before_run", (event: { prompt: unknown[] }) => emit("turn", "start", { promptMessages: event.prompt.length }));
	on("before_run_end", (event: { runId: string; messages: unknown[] }) =>
		emit("turn", "end", { runId: event.runId, messages: event.messages.length }),
	);
	on("transform_context", (event: { systemPrompt: string; messages: unknown[] }) =>
		emit("prompt", "assembled", { systemPromptChars: event.systemPrompt.length, messages: event.messages.length }),
	);
	on("before_request", (event: { attempt: number; step: string; model: { id: string } }) => {
		if (event.attempt > 1) emit("retry", "request", { attempt: event.attempt, step: event.step, model: event.model.id });
	});
	on("after_response", (event: { message: { usage?: Record<string, unknown> } }) => {
		if (event.message.usage !== undefined) emit("usage", "response", { usage: event.message.usage });
	});
	on("before_tool", (event: { toolCallId: string; toolName: string }) =>
		emit("tool", "start", { toolCallId: event.toolCallId, toolName: event.toolName }),
	);
	on("after_tool", (event: { toolCallId: string; toolName: string; isError: boolean; usage?: unknown }) =>
		emit("tool", "end", {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			isError: event.isError,
			...(event.usage !== undefined ? { usage: event.usage } : {}),
		}),
	);
	on("before_compaction", (event: { reason: string }) => emit("compaction", "start", { reason: event.reason }));
	return {
		emit,
		detach() {
			emit("lifecycle", "detach");
			for (const off of offs) off();
		},
	};
}
