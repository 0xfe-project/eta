/**
 * The kernel's event vocabulary, and the one cast that puts it on the cordis bus.
 *
 * Deliberately not a `declare module "cordis"` augmentation: a package meant to
 * be a stable floor should not widen its dependency's interfaces. The cast
 * lives here, once, and every call site stays checked against `KernelEvents`.
 *
 * Vocabulary discipline: payloads are pure-data snapshots of observable state.
 * Nothing here hands out live objects from the runner or a service, and event
 * names are flat strings grouped by prefix (`goal:`, `task:`, `persona:`,
 * `turn:`, `tool:`, `storage:`) — the snapshot test pins the exact list.
 */
import type { Context } from "cordis";
import type { Entry, GoalPayload } from "./entries.ts";
import type { AgentMessage, Usage } from "./messages.ts";
import type { PersonaCard } from "./persona.ts";
import type { TaskChange } from "./tasks.ts";

export interface GoalEvents {
	/** Fires with every transition; `payload.kind` carries the action. */
	"goal:changed": GoalPayload & { statusBefore: GoalStatusName; roundCount: number };
	"goal:cleared": { objective: string | undefined };
}

export type GoalStatusName = "none" | "active" | "paused" | "achieved";

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
}

export interface TurnEvents {
	/** Emitted when a new turn starts, with the resolved context assembly stats. */
	"turn:start": { turn: number; contextParts: ContextPartStats };
	/** Emitted when a turn's provider generation settles. */
	"turn:end": { turn: number; usage: Usage; stopReason: string };
	/** Emitted when the run ends (no continuation this round). */
	"turn:run-end": { turns: number; usage: Usage };
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

export interface ToolEvents {
	"tool:call": { name: string; args: unknown; turn: number };
	"tool:result": {
		name: string;
		result: unknown;
		/** Wall-clock ms of the call; middleware authors measure, not the runner. */
		durationMs: number;
		turn: number;
	};
}

export interface StorageEvents {
	"storage:changed": { key: string };
	"storage:appended": { entry: Entry };
	"storage:compacted": { before: number; after: number };
	"storage:error": { op: string; error: string };
}

export interface InjectEvents {
	/** A message entered the kernel through `inject()`. */
	"inject:received": { message: AgentMessage };
}

export interface KernelEvents
	extends GoalEvents,
		PersonaEvents,
		TaskEvents,
		TurnEvents,
		ToolEvents,
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
	"goal:changed",
	"goal:cleared",
	"inject:received",
	"persona:loaded",
	"persona:missing",
	"persona:switched",
	"storage:appended",
	"storage:changed",
	"storage:compacted",
	"storage:error",
	"task:cancelled",
	"task:completed",
	"task:created",
	"task:removed",
	"task:updated",
	"tool:call",
	"tool:result",
	"turn:end",
	"turn:run-end",
	"turn:start",
] as const;

export type KernelEventName = (typeof KERNEL_EVENT_NAMES)[number];

/** Compile-time lock: the interface keys and the pinned names must match exactly. */
export type _VocabularyMatches = keyof KernelEvents extends KernelEventName ? true : never;
