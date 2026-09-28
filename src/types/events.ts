/**
 * The kernel's event vocabulary, and the one cast that puts it on the cordis bus.
 *
 * Deliberately not a `declare module "cordis"` augmentation: a package meant to
 * be a stable floor should not widen its dependency's interfaces. The cast
 * lives here, once, and every call site stays checked against `KernelEvents`.
 *
 * Vocabulary discipline, aligned with eta-agent's events.ts:
 * - the category list is eta-agent's own (ETA_EVENT_CATEGORIES); the kernel
 *   emits a subset, with names as `category:action`;
 * - payloads mirror eta-agent's HarnessEventPayload shapes and are pure-data
 *   snapshots — nothing here hands out live objects from the runner or a
 *   service;
 * - a name enters the pinned list only when something emits it; streaming,
 *   retry, and compaction events land with their runner machinery.
 */
import type { Context } from "cordis";
import type { GoalStatus } from "../kernel/goal";
import type { UsageRow } from "../storage/types";
import type { Entry, GoalPayload } from "./entries";
import type { JsonValue } from "./json";
import type { AgentMessage, AssistantMessage, AssistantMessageEvent, Usage } from "./messages";
import type { PersonaCard } from "./persona";
import type { TaskChange } from "./tasks";

/** eta-agent's event categories, kept verbatim. */
export const ETA_EVENT_CATEGORIES = [
	"lifecycle",
	"turn",
	"usage",
	"prompt",
	"compaction",
	"loop",
	"goal",
	"memory",
	"skill",
	"task",
	"state",
	"tool",
	"retry",
	"ask_user",
	"btw",
] as const;

export type EtaEventCategory = (typeof ETA_EVENT_CATEGORIES)[number];

export type GoalStatusName = "none" | GoalStatus;

export interface GoalEvents {
	/** Fires with every transition; `payload.kind` carries the action. */
	"goal:changed": GoalPayload & { statusBefore: GoalStatusName; roundCount: number };
	"goal:cleared": { objective: string | undefined };
}

export interface PersonaEvents {
	"persona:loaded": { card: PersonaCard };
	"persona:switched": { active: PersonaCard[]; missing: string[] };
	/** Degraded mode: a referenced persona card is absent; the session survives. */
	"persona:missing": { id: string };
}

export interface TaskEvents {
	"task:created": TaskChange;
	"task:updated": TaskChange;
	"task:removed": TaskChange;
	/** Semantic alias, fires alongside `task:updated` on that transition. */
	"task:completed": TaskChange;
	/** Semantic alias, fires alongside `task:updated` on that transition. */
	"task:cancelled": TaskChange;
	/**
	 * The cadence says a task reminder is due this turn; the prompts plugin
	 * injects the text. Fires once per cycle, transient by design.
	 */
	"task:reminder-due": { turn: number };
}

/** Per-part token estimates for the context donut; runner reports, UI computes. */
export interface ContextPartStats {
	system: number;
	persona: number;
	user: number;
	assistant: number;
	toolDefs: number;
	total: number;
}

export interface TurnEvents {
	/** A run started. */
	"turn:run-start": { runId: string; startedAt: number };
	/** A turn started, with the resolved context assembly stats. */
	"turn:start": { runId: string; turnId: string; contextParts: ContextPartStats };
	/** A turn's provider generation settled. */
	"turn:end": {
		runId: string;
		turnId: string;
		message: AssistantMessage;
		toolResults: AgentMessage[];
		usage: Usage;
	};
	/** The run ended: a clean stop, a failure, or the caller cancelling it. */
	"turn:run-end": {
		runId: string;
		turns: number;
		endedAt: number;
		status: "completed" | "failed" | "aborted";
		error?: string;
	};
}

export interface MessageEvents {
	/** A provider generation opened. */
	"message:start": { runId: string; turnId: string };
	/** One stream frame: the delta plus the message as it stands. Snapshots, not live refs. */
	"message:update": { runId: string; turnId: string; message: AgentMessage; event: AssistantMessageEvent };
	/**
	 * A message became part of the transcript. The entry id does not exist yet:
	 * the journaling subscriber assigns it and announces `entry:added`.
	 */
	"message:end": { runId?: string; message: AgentMessage; terminate?: true };
}

export interface PromptEvents {
	/** Emitted once the system prompt and context are assembled for a request. */
	"prompt:assembled": { runId: string; systemPromptChars: number; messages: number; attempt: number };
}

export interface ToolEvents {
	"tool:start": { runId: string; turnId: string; toolCallId: string; toolName: string; args: unknown };
	/**
	 * One progress report from a running tool (a streamed command's output, an
	 * edit's progress). Transient by design: partial results are never journaled.
	 */
	"tool:update": {
		runId: string;
		turnId: string;
		toolCallId: string;
		toolName: string;
		partialResult: unknown;
		/** The tool marked this update as one worth keeping (bash does, every 2s). */
		checkpoint?: boolean;
	};
	"tool:end": {
		runId: string;
		turnId: string;
		toolCallId: string;
		toolName: string;
		result: unknown;
		isError: boolean;
		terminate: boolean;
		/** Wall-clock ms of the call; middleware authors measure, not the runner. */
		durationMs: number;
	};
}

export interface CompactionEvents {
	"compaction:start": { runId: string; reason: "manual" | "threshold" | "overflow"; startedAt: number };
	"compaction:end": {
		runId: string;
		reason: "manual" | "threshold" | "overflow";
		endedAt: number;
		status: "completed" | "declined" | "failed";
		/** What the context was replaced with; the journaling subscriber writes it. */
		summary?: string;
		retainedTail?: AgentMessage[];
		tokensBefore?: number;
		details?: JsonValue;
		usage?: Usage;
		error?: string;
	};
}

export interface RetryEvents {
	/** A retryable failure scheduled another attempt, with the backoff that follows. */
	"retry:scheduled": {
		runId: string;
		step: string;
		/** The attempt that will run next (1-based). */
		attempt: number;
		maxAttempts: number;
		delayMs: number;
		notBefore: number;
		errorMessage: string;
	};
	/** The backoff elapsed and the retried call is starting. */
	"retry:start": { runId: string; step: string; attempt: number };
	/** A retried call finished: success, or the failure that ended the run. */
	"retry:end": { runId: string; step: string; attempt: number; success: boolean; finalError?: string };
}

export interface EntryEvents {
	/** A journaled entry, with the id the journal assigned it. */
	"entry:added": { entry: Entry };
}

export interface UsageEvents {
	/** One usage measurement landed; totals are the session aggregate after it. */
	"usage:recorded": { row: UsageRow; totals: Usage };
}

export interface StateEvents {
	/** A configuration property changed; the runner reads config live, so this is how a UI learns. */
	"state:config-update": { property: string; value: unknown; previous: unknown };
}

export interface StorageEvents {
	"storage:appended": { entry: Entry };
	"storage:compacted": { before: number; after: number };
	"storage:error": { op: string; error: string };
}

export interface QueueEvents {
	/** The inbox changed; the runner reports what is left after taking its share. */
	"queue:update": { queues: { entryId: string; kind: string }[] };
}

export interface InjectEvents {
	/** A message entered the kernel through `inject()`. */
	"inject:received": { message: AgentMessage };
}

export interface KernelEvents
	extends CompactionEvents,
		EntryEvents,
		GoalEvents,
		PersonaEvents,
		TaskEvents,
		TurnEvents,
		MessageEvents,
		PromptEvents,
		QueueEvents,
		RetryEvents,
		ToolEvents,
		UsageEvents,
		StateEvents,
		StorageEvents,
		InjectEvents {}

/** A bus emit that is checked against the kernel's own vocabulary. */
export type Emit = <K extends keyof KernelEvents>(name: K, payload: KernelEvents[K]) => void;

/** The mirror of `Emit` for consumers: a checked `on`. */
export type On = <K extends keyof KernelEvents>(name: K, listener: (payload: KernelEvents[K]) => void) => () => boolean;

/**
 * The single cast. Cordis' `emit`/`on` are keyed on its own `Events`
 * interface, which cannot see the kernel's names without an augmentation;
 * this bridges it without widening cordis' surface.
 */
export function kernelEmit(ctx: Context): Emit {
	const raw = (ctx as unknown as { emit(name: string, payload: unknown): void }).emit.bind(ctx);
	return raw as Emit;
}

/** The mirror of `kernelEmit`, for plugins and the host that consume the bus. */
export function kernelOn(ctx: Context): On {
	const raw = (ctx as unknown as { on(name: string, listener: (payload: unknown) => void): () => boolean }).on.bind(
		ctx,
	);
	return raw as On;
}

/** Alphabetized event-name list, pinned by a snapshot test so the vocabulary cannot drift. */
export const KERNEL_EVENT_NAMES = [
	"compaction:end",
	"compaction:start",
	"entry:added",
	"goal:changed",
	"goal:cleared",
	"inject:received",
	"message:end",
	"message:start",
	"message:update",
	"persona:loaded",
	"persona:missing",
	"persona:switched",
	"prompt:assembled",
	"queue:update",
	"retry:end",
	"retry:scheduled",
	"retry:start",
	"state:config-update",
	"storage:appended",
	"storage:compacted",
	"storage:error",
	"task:cancelled",
	"task:completed",
	"task:created",
	"task:reminder-due",
	"task:removed",
	"task:updated",
	"tool:end",
	"tool:start",
	"tool:update",
	"turn:end",
	"turn:run-end",
	"turn:run-start",
	"turn:start",
	"usage:recorded",
] as const;

export type KernelEventName = (typeof KERNEL_EVENT_NAMES)[number];

/** Compile-time lock: the interface keys and the pinned names must match exactly. */
export type _VocabularyMatches = keyof KernelEvents extends KernelEventName ? true : never;
