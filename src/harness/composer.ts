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
	/** Rendered <skills> catalog block; stable, appended after the persona. */
	skills?: string;
	/** Rendered <memory> block; always last, it changes most often. */
	memory?: string;
}

/** One section pipeline: order and stable/adaptive tagging defined once. */
export interface EtaPromptSection {
	name: "base" | "persona" | "skills" | "goal" | "tasks" | "memory";
	stable: boolean;
	text: string;
}

function sections(base: string, state: EtaPromptState): EtaPromptSection[] {
	const out: EtaPromptSection[] = [{ name: "base", text: base, stable: true }];
	if (state.persona !== undefined && state.persona.length > 0) out.push({ name: "persona", text: state.persona, stable: true });
	if (state.skills !== undefined && state.skills.length > 0) out.push({ name: "skills", text: state.skills, stable: true });
	if (state.goal && state.goal.status === "active") out.push({ name: "goal", text: goalPursuitGuidelines(state.goal.objective), stable: false });
	if (state.tasks && state.tasks.length > 0) out.push({ name: "tasks", text: `${TASK_REVIEW_PROMPT}\n\n${renderCurrentTasks(state.tasks)}`, stable: false });
	if (state.memory !== undefined && state.memory.length > 0) out.push({ name: "memory", text: state.memory, stable: false });
	return out.filter((section) => section.text.length > 0);
}

/** The live prompt as named blocks, for the Context panel's prompt dialog. */
export function etaPromptSectionsDetailed(base: string, state: EtaPromptState): EtaPromptSection[] {
	return sections(base, state);
}

/** The prompt split the way the Context panel thinks about it: what a provider
 * cache keeps across turns versus what gets rewritten every generation. */
export function splitEtaPromptSections(base: string, state: EtaPromptState): { stable: string[]; adaptive: string[] } {
	const all = sections(base, state);
	return { stable: all.filter((s) => s.stable).map((s) => s.text), adaptive: all.filter((s) => !s.stable).map((s) => s.text) };
}

export function etaPromptBlockChars(base: string, state: EtaPromptState): { stableChars: number; adaptiveChars: number } {
	const { stable, adaptive } = splitEtaPromptSections(base, state);
	const chars = (parts: string[]) => parts.reduce((sum, part) => sum + part.length, 0);
	return { stableChars: chars(stable), adaptiveChars: chars(adaptive) };
}

/** Sections appended after the base prompt, in stable order. */
export function etaPromptSections(state: EtaPromptState): string[] {
	return sections("", state).map((section) => section.text);
}

/** The composed prompt handed to the harness `systemPrompt` option. */
export function composeEtaSystemPrompt(base: string, state: EtaPromptState): string {
	return sections(base, state).map((section) => section.text).join("\n\n");
}
