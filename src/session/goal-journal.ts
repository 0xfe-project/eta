/**
 * Goal journaling — state changes become history through a subscriber, not by
 * the primitive reaching for storage (REFACTOR.md §2.3). The goal service
 * emits; this writes; replay restores via `applyGoalEntries`.
 */

import type { GoalEntry, NewEntry } from "../types/entries";
import type { kernelOn } from "../types/events";
import type { SessionLog } from "./session-log";

let counter = 0;
function goalEntryId(): string {
	counter += 1;
	return `goal-${counter.toString(36)}-${Date.now().toString(36)}`;
}

/** Mirror goal changes into the journal as `goal` entries. */
export function recordGoalEntries(log: SessionLog, subscribe: ReturnType<typeof kernelOn>): { stop: () => void } {
	const off: (() => boolean)[] = [];
	off.push(
		subscribe("goal:changed", (event) => {
			log.record<GoalEntry>({
				id: goalEntryId(),
				parentId: null,
				type: "goal",
				payload: {
					kind: event.kind,
					...(event.objective === undefined ? {} : { objective: event.objective }),
					...(event.reason === undefined ? {} : { reason: event.reason }),
				},
			} as NewEntry<GoalEntry>);
		}),
	);
	off.push(
		subscribe("goal:cleared", (event) => {
			log.record<GoalEntry>({
				id: goalEntryId(),
				parentId: null,
				type: "goal",
				payload: { kind: "cleared", ...(event.objective === undefined ? {} : { objective: event.objective }) },
			} as NewEntry<GoalEntry>);
		}),
	);
	return { stop: () => off.forEach((unsubscribe) => void unsubscribe()) };
}
