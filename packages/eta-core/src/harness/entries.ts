/**
 * The session log records goal changes, ask_user questions and answers, and
 * btw notes as first-class entry types, exactly like messages and compactions.
 * These constructors build queued entries for lane.append; loop state persists
 * as a session value (see values.ts loopState).
 */

export type { GoalPayload, AskPayload, AnswerPayload, BtwPayload } from "./session/types.ts";
import type { AnswerPayload, AskPayload, BtwPayload, GoalPayload, PendingEntry } from "./session/types.ts";

export function goalEntry(payload: GoalPayload): Extract<PendingEntry, { type: "goal" }> {
	return { type: "goal", payload };
}

export function askEntry(payload: AskPayload): Extract<PendingEntry, { type: "ask" }> {
	return { type: "ask", payload };
}

export function answerEntry(payload: AnswerPayload): Extract<PendingEntry, { type: "answer" }> {
	return { type: "answer", payload };
}

export function btwEntry(payload: BtwPayload): Extract<PendingEntry, { type: "btw" }> {
	return { type: "btw", payload };
}
