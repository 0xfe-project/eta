/**
 * Goal subsystem: turn-internal self-continuation with anti-spin bookkeeping.
 * Port of the Rust core's goal semantics (old agent.rs B8 + goal.rs).
 * Pure state machine; persistence and event emission are the caller's job
 * (eta.goal CustomEntry / telemetry category "goal").
 */

import type { GoalPayload } from "./session/types.ts";
import type { DevEmit } from "./dev-events.ts";

export type GoalStatus = "active" | "paused" | "achieved";

export type GoalBlockedReason = "question-pending" | undefined;

/** Continuation gate: "auto" self-continues; "delegated" keeps the goal alive
 * but external signals alone drive it (master parallel phase). */
export type GoalGate = "auto" | "delegated";

export interface GoalState {
	objective: string;
	status: GoalStatus;
	roundCount: number;
	idleWithoutTools: number;
	blockedReason?: GoalBlockedReason;
}

/** Consecutive tool-free turns before the goal auto-pauses. */
export const ANTI_SPIN_LIMIT = 3;
/** Hard cap on self-continuations per goal. */
export const MAX_CONTINUATIONS = 12;

export interface GoalChange {
	from: GoalStatus | "none";
	goal: GoalState;
}

export class GoalManager {
	private goal: GoalState | undefined;
	gate: GoalGate = "auto";
	maxContinuations = MAX_CONTINUATIONS;
	antiSpinLimit = ANTI_SPIN_LIMIT;
	onChange?: (change: GoalChange) => void;
	dev?: DevEmit;

	get current(): GoalState | undefined {
		return this.goal;
	}

	set(objective: string): GoalChange {
		const from = this.goal?.status ?? ("none" as const);
		this.goal = { objective, status: "active", roundCount: 0, idleWithoutTools: 0 };
		const change: GoalChange = { from, goal: { ...this.goal } };
		this.changed(change, "set");
		return change;
	}

	private changed(change: GoalChange, action: string): void {
		this.dev?.("goal", action, { status: change.goal.status, from: change.from });
		this.onChange?.(change);
	}

	pause(): void {
		if (!this.goal || this.goal.status === "achieved") return;
		const from = this.goal.status;
		this.goal.status = "paused";
		this.changed({ from, goal: { ...this.goal } }, "paused");
	}

	resume(): void {
		if (!this.goal || this.goal.status === "achieved") return;
		const from = this.goal.status;
		this.goal.status = "active";
		this.goal.idleWithoutTools = 0;
		this.goal.blockedReason = undefined;
		this.changed({ from, goal: { ...this.goal } }, "resumed");
	}

	markAchieved(): void {
		if (!this.goal) return;
		const from = this.goal.status;
		this.goal.status = "achieved";
		this.changed({ from, goal: { ...this.goal } }, "achieved");
	}

	clear(): void {
		if (!this.goal) return;
		const from = this.goal.status;
		this.goal = undefined;
		this.changed({ from, goal: { objective: "", status: "achieved", roundCount: 0, idleWithoutTools: 0 } }, "cleared");
	}

	setBlockedReason(reason: GoalBlockedReason): void {
		if (!this.goal) return;
		this.goal.blockedReason = reason;
	}

	/** Call at turn end with whether the turn produced tool work.
	 * Applies anti-spin: N consecutive tool-free turns pause the goal.
	 * Returns true when a pause happened (caller emits the change event). */
	recordTurnOutcome(hadTools: boolean): boolean {
		if (!this.goal || this.goal.status !== "active") return false;
		if (hadTools) {
			this.goal.idleWithoutTools = 0;
			return false;
		}
		this.goal.idleWithoutTools += 1;
		if (this.goal.idleWithoutTools >= this.antiSpinLimit) {
			this.goal.status = "paused";
			this.changed({ from: "active", goal: { ...this.goal } }, "spun_down");
			return true;
		}
		return false;
	}

	/** Whether the goal manager should enqueue a continuation driver now.
	 * The caller then runs the evaluator; `noteContinuation` on pass. */
	wantsContinuation(): boolean {
		return (
			this.gate === "auto" &&
			this.goal?.status === "active" &&
			this.goal.roundCount < this.maxContinuations
		);
	}

	noteContinuation(): void {
		if (this.goal) {
			this.goal.roundCount += 1;
			this.dev?.("goal", "continued", { roundCount: this.goal.roundCount });
		}
	}
}

/** Intent phrases: the model says it is mid-task; continue without a goal. */
const INTENT_PHRASES = [
	"now let me",
	"next i'll",
	"next i will",
	"continuing with",
	"i'll now",
	"i will now",
	"let me now",
	"moving on to",
	"proceeding to",
];

/** True when the last assistant text shows clear intent to keep working. */
export function lastMessageShowsIntent(text: string): boolean {
	const lower = text.toLowerCase();
	return INTENT_PHRASES.some((phrase) => lower.includes(phrase));
}

/** Restore goal state from a replayed `eta.goal` entry log (restart path). */
export function applyGoalEntries(manager: GoalManager, entries: { type: string; payload: unknown }[]): void {
	for (const entry of entries) {
		if (entry.type !== "goal") continue;
		const payload = entry.payload as GoalPayload;
		switch (payload.kind) {
			case "set":
				if (payload.objective !== undefined) manager.set(payload.objective);
				break;
			case "pause":
				manager.pause();
				break;
			case "resume":
				manager.resume();
				break;
			case "achieved":
				manager.markAchieved();
				break;
			case "cleared":
				manager.clear();
				break;
			case "blocked":
				manager.setBlockedReason(payload.reason as GoalBlockedReason | undefined);
				break;
		}
	}
}
