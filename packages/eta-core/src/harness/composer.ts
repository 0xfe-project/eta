/**
 * System prompt assembly for eta batteries.
 *
 * the harness keeps one string prompt per generation, resolved fresh each turn via
 * `AgentHarnessOptions.systemPrompt` and then rewritten by the
 * `transform_context` hook. So eta never patches the drive loop for prompts:
 * it wraps the base prompt in this composer, and everything else (goal
 * guidelines, task review) rides the same single string. Order below is fixed
 * and tested; keep it stable for provider prompt caches.
 */

import type { GoalStatus } from "./goal.ts";
import { goalPursuitGuidelines, TASK_REVIEW_PROMPT } from "../prompts/index.ts";
import { renderCurrentTasks, type Task } from "./tasks.ts";

export interface EtaPromptState {
	goal?: { objective: string; status: GoalStatus };
	tasks?: Task[];
	/** Rendered persona block (stable card text); goes right after the base prompt. */
	persona?: string;
	/** Rendered <memory> block; always last, it changes most often. */
	memory?: string;
}

/** The prompt split the way the Context panel thinks about it: what a provider
 * cache keeps across turns versus what gets rewritten every generation. */
export function splitEtaPromptSections(base: string, state: EtaPromptState): { stable: string[]; adaptive: string[] } {
	const stable = [base, state.persona ?? ""].filter((part) => part.length > 0);
	const adaptive: string[] = [];
	if (state.goal && state.goal.status === "active") {
		adaptive.push(goalPursuitGuidelines(state.goal.objective));
	}
	if (state.tasks && state.tasks.length > 0) {
		adaptive.push(`${TASK_REVIEW_PROMPT}\n\n${renderCurrentTasks(state.tasks)}`);
	}
	if (state.memory !== undefined && state.memory.length > 0) adaptive.push(state.memory);
	return { stable, adaptive };
}

export function etaPromptBlockChars(base: string, state: EtaPromptState): { stableChars: number; adaptiveChars: number } {
	const { stable, adaptive } = splitEtaPromptSections(base, state);
	const chars = (parts: string[]) => parts.reduce((sum, part) => sum + part.length, 0);
	return { stableChars: chars(stable), adaptiveChars: chars(adaptive) };
}

/** Sections appended after the base prompt, in stable order. */
export function etaPromptSections(state: EtaPromptState): string[] {
	const sections: string[] = [];
	if (state.persona !== undefined && state.persona.length > 0) sections.push(state.persona);
	if (state.goal && state.goal.status === "active") {
		sections.push(goalPursuitGuidelines(state.goal.objective));
	}
	if (state.tasks && state.tasks.length > 0) {
		sections.push(`${TASK_REVIEW_PROMPT}\n\n${renderCurrentTasks(state.tasks)}`);
	}
	if (state.memory !== undefined && state.memory.length > 0) sections.push(state.memory);
	return sections;
}

/** The composed prompt handed to the harness `systemPrompt` option. */
export function composeEtaSystemPrompt(base: string, state: EtaPromptState): string {
	return [base, ...etaPromptSections(state)].filter((s) => s.length > 0).join("\n\n");
}
