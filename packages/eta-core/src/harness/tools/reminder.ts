/**
 * Transient <system-reminder> task nudges (C4): after_tool feeds the cadence,
 * transform_context injects. Never committed to the transcript.
 */

import type { AgentMessage } from "../../types.ts";
import { TODO_REVIEW_PROMPT } from "../../prompts/index.ts";
import { createCadenceState, drainReminderForContext, evaluateToolResult, onTurnStart, type CadenceState } from "../cadence.ts";
import type { TaskStore } from "../task-store.ts";
import { TASK_TOOL_NAMES } from "./tasks.ts";

export interface ReminderHooks {
	state: CadenceState;
	onTurnStart(): void;
	afterTool(event: { toolName: string }): undefined;
	transformContext(event: { messages: AgentMessage[] }): { messages: AgentMessage[] } | undefined;
}

/** Transient <system-reminder> nudges: after_tool feeds cadence, transform_context injects. */
export function createReminderHooks(store: TaskStore, reminderInterval = 5): ReminderHooks {
	const state = createCadenceState();
	const config = { reminderInterval, taskToolNames: TASK_TOOL_NAMES };
	return {
		state,
		onTurnStart: () => onTurnStart(state),
		afterTool: (event) => {
			evaluateToolResult(state, event.toolName, store.list().length > 0, config);
			return undefined;
		},
		transformContext: (event) => {
			if (!drainReminderForContext(state)) return undefined;
			return {
				messages: [
					...event.messages,
					{ role: "user", content: `<system-reminder>\n${TODO_REVIEW_PROMPT}\n</system-reminder>`, timestamp: Date.now() },
				],
			};
		},
	};
}
