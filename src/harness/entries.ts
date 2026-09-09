/**
 * CustomEntry payload contracts (D1: all new session semantics ride on
 * CustomEntry.customType, so upstream entry types stay untouched and
 * upstream storage conformance keeps passing).
 */

export const GOAL_CUSTOM_TYPE = "eta.goal";
export const ASK_CUSTOM_TYPE = "eta.ask";
export const ANSWER_CUSTOM_TYPE = "eta.answer";
export const BTW_CUSTOM_TYPE = "eta.btw";

export interface GoalPayload {
	kind: "set" | "pause" | "resume" | "achieved" | "cleared" | "blocked";
	objective?: string;
	reason?: string;
}

export interface AskPayload {
	questionId: string;
	question: string;
	options?: string[];
	multi?: boolean;
}

export interface AnswerPayload {
	questionId: string;
	answers: string[];
	skipped?: boolean;
}

export interface BtwPayload {
	note: string;
	sourceEntryId?: string;
}

export function goalEntry(payload: GoalPayload): { customType: string; payload: GoalPayload } {
	return { customType: GOAL_CUSTOM_TYPE, payload };
}

export function askEntry(payload: AskPayload): { customType: string; payload: AskPayload } {
	return { customType: ASK_CUSTOM_TYPE, payload };
}

export function answerEntry(payload: AnswerPayload): { customType: string; payload: AnswerPayload } {
	return { customType: ANSWER_CUSTOM_TYPE, payload };
}

export function btwEntry(payload: BtwPayload): { customType: string; payload: BtwPayload } {
	return { customType: BTW_CUSTOM_TYPE, payload };
}

const TYPES = new Set([GOAL_CUSTOM_TYPE, ASK_CUSTOM_TYPE, ANSWER_CUSTOM_TYPE, BTW_CUSTOM_TYPE]);

export function isEtaCustomType(customType: string): boolean {
	return TYPES.has(customType);
}
