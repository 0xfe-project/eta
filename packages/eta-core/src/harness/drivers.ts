/**
 * Run-end batteries wired through the harness's own `before_run_end` hook
 * (the durable followUp channel; see drive/boundary.ts finishRunBoundary).
 *
 * - goal driver (S1): when the goal is still active and the evaluator says
 *   not achieved, enqueue a continuation followUp instead of ending the run.
 *   Tool-free runs feed the anti-spin counter.
 * - empty response guard (S2): the provider stopped with nothing to show;
 *   nudge it back within a small budget (the drive itself never retries a
 *   well-formed empty answer, and we keep the drive untouched for upstream
 *   sync).
 */

import type { AgentMessage } from "../types.ts";
import { RESUME_EMPTY, GOAL_CONTINUATION } from "../prompts/index.ts";
import type { GoalManager } from "./goal.ts";

export interface RunEndEvent {
	messages: AgentMessage[];
}

export interface GoalDriverDeps {
	goal: GoalManager;
	/** Independent judgment call (tool-free request); true = achieved. */
	evaluate(objective: string, messages: AgentMessage[]): Promise<boolean>;
}

/** Slice of the transcript belonging to the run that just ended. */
function currentRun(messages: AgentMessage[]): AgentMessage[] {
	for (let i = messages.length - 1; i >= 0; i--) {
		const role = (messages[i] as { role?: string }).role;
		if (role === "user") return messages.slice(i);
	}
	return messages;
}

function runUsedTools(messages: AgentMessage[]): boolean {
	for (const m of currentRun(messages)) {
		const role = (m as { role?: string }).role;
		if (role === "tool" || role === "toolResult") return true;
		const content = (m as { content?: unknown }).content;
		if (
			role === "assistant" &&
			Array.isArray(content) &&
			content.some((p) => (p as { type?: string }).type === "toolCall")
		) {
			return true;
		}
	}
	return false;
}

/** before_run_end handler driving goal self-continuation. */
export function goalDriver(deps: GoalDriverDeps) {
	return async (event: RunEndEvent): Promise<{ followUp?: string } | undefined> => {
		deps.goal.recordTurnOutcome(runUsedTools(event.messages));
		if (!deps.goal.wantsContinuation()) {
			// Hit the hard continuation cap: park the goal instead of leaving it a zombie.
			const state = deps.goal.current;
			if (state !== undefined && state.status === "active" && state.roundCount >= deps.goal.maxContinuations)
				deps.goal.pause();
			return undefined;
		}
		const objective = deps.goal.current?.objective;
		if (objective === undefined) return undefined;
		if (await deps.evaluate(objective, event.messages)) {
			deps.goal.markAchieved();
			return undefined;
		}
		deps.goal.noteContinuation();
		return { followUp: GOAL_CONTINUATION };
	};
}

/** True when an assistant message stopped cleanly with nothing in it. */
export function isEmptyStop(message: AgentMessage): boolean {
	const m = message as { role?: string; stopReason?: string; content?: unknown };
	if (m.role !== "assistant" || m.stopReason !== "stop") return false;
	if (!Array.isArray(m.content) || m.content.length === 0) return true;
	return m.content.every((p) => {
		const part = p as { type?: string; text?: string };
		return part.type === "text" && (part.text ?? "").trim() === "";
	});
}

/** before_run_end handler retrying well-formed-but-empty responses. */
export function emptyResponseGuard(maxRetries = 2) {
	let used = 0;
	return (event: RunEndEvent): { followUp?: string } | undefined => {
		const last = event.messages[event.messages.length - 1];
		if (last === undefined || !isEmptyStop(last)) {
			used = 0;
			return undefined;
		}
		if (used >= maxRetries) {
			used = 0;
			return undefined;
		}
		used += 1;
		return { followUp: RESUME_EMPTY };
	};
}

/**
 * before_run_end handler: pumps the loop scheduler at run boundaries and hands
 * the first due loop back as a followUp driver (one per boundary; the rest
 * wait for the next tick).
 */
export function loopDriver(scheduler: import("./loops.ts").LoopScheduler) {
	return (): { followUp?: string } | undefined => {
		const first = scheduler.pump(Date.now()).fired[0];
		return first === undefined ? undefined : { followUp: first.followUp };
	};
}

/** Idle-session heartbeat: pumps every interval (unref'd, stops on returned call). */
export function startLoopHeartbeat(scheduler: import("./loops.ts").LoopScheduler, intervalMs = 30_000): () => void {
	const timer = setInterval(() => scheduler.pump(Date.now()), intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}
