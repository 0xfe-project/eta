/**
 * GoalService — the goal primitive.
 *
 * Full port of eta-agent's harness/goal.ts GoalManager semantics: the state
 * machine (none → active → paused/achieved), anti-spin spin-down, the
 * continuation round cap, and the auto/delegated gate are all here because
 * they ARE the goal's observable state transitions — the runner only asks
 * `wantsContinuation()` at run boundaries (REFACTOR.md §2.3.1, §3 ruling 1).
 *
 * Persistence is the bus's job: every transition emits `goal:changed` (or
 * `goal:cleared`), and a subscriber with a StorageService writes the matching
 * `goal` entry. Replay is `applyGoalEntries`.
 */

import type { Context } from "cordis";
import { Service } from "cordis";
import type { GoalEntry, GoalPayload } from "../types/entries";
import type { Emit } from "../types/events";
import { kernelEmit } from "../types/events";

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

export class GoalService extends Service {
	static readonly provide = "goal";

	private state: GoalState | undefined;
	gate: GoalGate = "auto";
	maxContinuations = MAX_CONTINUATIONS;
	antiSpinLimit = ANTI_SPIN_LIMIT;
	private readonly emit: Emit;

	constructor(ctx: Context) {
		super(ctx, "goal");
		this.emit = kernelEmit(ctx);
	}

	get current(): GoalState | undefined {
		return this.state;
	}

	set(objective: string): void {
		this.state = { objective, status: "active", roundCount: 0, idleWithoutTools: 0 };
		this.changed({ kind: "set", objective }, "none");
	}

	pause(reason?: string): void {
		if (!this.state || this.state.status === "achieved") return;
		const from = this.state.status;
		this.state.status = "paused";
		this.changed({ kind: "pause", objective: this.state.objective, reason }, from);
	}

	resume(): void {
		if (!this.state || this.state.status === "achieved") return;
		const from = this.state.status;
		this.state.status = "active";
		this.state.idleWithoutTools = 0;
		this.state.blockedReason = undefined;
		this.changed({ kind: "resume", objective: this.state.objective }, from);
	}

	markAchieved(): void {
		if (!this.state) return;
		const from = this.state.status;
		this.state.status = "achieved";
		this.changed({ kind: "achieved", objective: this.state.objective }, from);
	}

	clear(): void {
		if (!this.state) return;
		const objective = this.state.objective;
		this.state = undefined;
		this.emit("goal:cleared", { objective });
	}

	setBlockedReason(reason: GoalBlockedReason): void {
		if (!this.state) return;
		this.state.blockedReason = reason;
		this.changed({ kind: "blocked", objective: this.state.objective, reason }, this.state.status);
	}

	/**
	 * Call at turn end with whether the turn produced tool work. Applies
	 * anti-spin: N consecutive tool-free turns pause the goal.
	 */
	recordTurnOutcome(hadTools: boolean): void {
		if (!this.state || this.state.status !== "active") return;
		if (hadTools) {
			this.state.idleWithoutTools = 0;
			return;
		}
		this.state.idleWithoutTools += 1;
		if (this.state.idleWithoutTools >= this.antiSpinLimit) {
			this.state.status = "paused";
			this.changed({ kind: "pause", objective: this.state.objective, reason: "anti-spin" }, "active");
		}
	}

	/** Whether the runner should run the evaluator and continue at this boundary. */
	wantsContinuation(): boolean {
		return this.gate === "auto" && this.state?.status === "active" && this.state.roundCount < this.maxContinuations;
	}

	noteContinuation(): void {
		if (this.state) this.state.roundCount += 1;
	}

	private changed(payload: GoalPayload, from: GoalStatus | "none"): void {
		this.emit("goal:changed", { ...payload, statusBefore: from, roundCount: this.state?.roundCount ?? 0 });
	}
}

/** Restore goal state from a replayed goal-entry log (restart path). */
export function applyGoalEntries(goal: GoalService, entries: GoalEntry[]): void {
	for (const entry of entries) {
		const payload = entry.payload;
		switch (payload.kind) {
			case "set":
				if (payload.objective !== undefined) goal.set(payload.objective);
				break;
			case "pause":
				goal.pause(payload.reason);
				break;
			case "resume":
				goal.resume();
				break;
			case "achieved":
				goal.markAchieved();
				break;
			case "cleared":
				goal.clear();
				break;
			case "blocked":
				goal.setBlockedReason(payload.reason as GoalBlockedReason);
				break;
		}
	}
}
