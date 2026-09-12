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
 * one followUp back per boundary (the rest keep their place in the scheduler's
 * queue and arrive at the boundaries after this one).
 */
export function loopDriver(scheduler: import("./loops.ts").LoopScheduler) {
	return (): { followUp?: string } | undefined => {
		scheduler.defer(scheduler.pump(Date.now()).fired.map((fired) => fired.followUp));
		const next = scheduler.takeDeferred();
		return next === undefined ? undefined : { followUp: next };
	};
}

export interface LoopHeartbeat {
	/** Re-read the registry: what it is waiting for may have just moved. */
	sync(count: number): void;
	stop(): void;
}

/** A loop due every few ms must not turn the wake timer into a busy loop. */
const WAKE_FLOOR_MS = 50;

/**
 * Idle-session wake. Two things it has to get right:
 *
 * - It arms for **when the earliest loop is due**, not on a fixed grid. A grid of 30s is
 *   silent for up to a whole cadence after a `5s` loop comes due, which is exactly the
 *   moment somebody asked it to say something.
 * - It may not swallow what fired. With no run in flight there is no boundary to hand the
 *   followUp to, so `onWake` is how a loop re-starts the agent; a heartbeat that pumped and
 *   dropped the result would tick the loop's count and do nothing else, which is worse than
 *   not firing — the loop looks alive in the UI.
 *
 * `cadenceMs` remains as the backstop: loops waiting on an event, and the sweep that
 * retires expired ones, still need a tick even though nothing is scheduled for them.
 */
export function startLoopHeartbeat(
	scheduler: import("./loops.ts").LoopScheduler,
	cadenceMs = 30_000,
	onWake?: (followUp: string, firedCount: number) => void,
): LoopHeartbeat {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const clear = () => {
		if (timer === undefined) return;
		clearTimeout(timer);
		timer = undefined;
	};
	const arm = (count: number) => {
		clear();
		const now = Date.now();
		const dueAt = scheduler.nextWakeAt(now);
		const wake = () => tick();
		if (dueAt === undefined) {
			// Nothing on a clock: keep a backstop tick only while the registry still holds
			// something (an event-triggered loop, or one whose expiry has to be swept).
			if (count === 0) return;
			timer = setTimeout(wake, cadenceMs);
		} else {
			const wait = Math.min(Math.max(dueAt - now, 0), cadenceMs);
			timer = setTimeout(wake, Math.max(wait, WAKE_FLOOR_MS));
		}
		timer.unref?.();
	};
	const tick = () => {
		const fired = scheduler.pump(Date.now()).fired;
		if (fired.length > 0) {
			scheduler.defer(fired.map((entry) => entry.followUp));
			const next = scheduler.takeDeferred();
			if (next !== undefined) onWake?.(next, fired.length);
		}
		arm(scheduler.list().length);
	};
	return {
		sync: (count) => arm(count),
		stop: clear,
	};
}
