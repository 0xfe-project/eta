/**
 * System prompt assembly for eta batteries.
 *
 * pi has one string prompt per generation, resolved fresh each turn via
 * `AgentHarnessOptions.systemPrompt` and then rewritten by the
 * `transform_context` hook. So eta never patches the drive loop for prompts:
 * it wraps the base prompt in this composer, and everything else (goal
 * guidelines, task review) rides the same single string. Order below is fixed
 * and tested; keep it stable for provider prompt caches.
 */

import type { GoalStatus } from "./goal.ts";
import { goalPursuitGuidelines, TODO_REVIEW_PROMPT } from "./prompts.ts";
import { renderCurrentTasks, type TaskList } from "./tasks.ts";

export interface EtaPromptState {
	goal?: { objective: string; status: GoalStatus };
	tasks?: TaskList;
}

/** Sections appended after the base prompt, in stable order. */
export function etaPromptSections(state: EtaPromptState): string[] {
	const sections: string[] = [];
	if (state.goal && state.goal.status === "active") {
		sections.push(goalPursuitGuidelines(state.goal.objective));
	}
	if (state.tasks && state.tasks.tasks.length > 0) {
		sections.push(`${TODO_REVIEW_PROMPT}\n\n${renderCurrentTasks(state.tasks)}`);
	}
	return sections;
}

/** The composed prompt handed to the harness `systemPrompt` option. */
export function composeEtaSystemPrompt(base: string, state: EtaPromptState): string {
	return [base, ...etaPromptSections(state)].filter((s) => s.length > 0).join("\n\n");
}
