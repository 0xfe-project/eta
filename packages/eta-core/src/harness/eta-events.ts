/**
 * The eta event vocabulary carried on the main HarnessEvent bus. Battery
 * activity (goal, loops, ask, btw, todo, state, memory, persona) rides the
 * same event stream as turn/tool/usage — one bus, one order, one lane tag.
 * Old core had fourteen categories; eta keeps them all and adds `btw`.
 * The lifecycle/turn/usage/prompt/compaction/tool/retry categories are the
 * native HarnessEvent variants themselves, not re-emitted here.
 */

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
	"todo",
	"state",
	"tool",
	"retry",
	"ask_user",
	"btw",
] as const;

export type EtaEventCategory = (typeof ETA_EVENT_CATEGORIES)[number];

export interface EtaEventData {
	[key: string]: unknown;
}

/** One battery observation on the main bus (lane-tagged like every other event). */
export interface EtaEventPayload {
	type: "eta";
	category: EtaEventCategory | string;
	action: string;
	data: EtaEventData;
}

/** Emitted by the generation step once the system prompt and context are assembled. */
export interface PromptAssembledPayload {
	type: "prompt_assembled";
	runId: string;
	systemPromptChars: number;
	messages: number;
	attempt: number;
}

/** Sink batteries call; the integrated agent binds it to the harness bus. */
export type EtaEmit = (category: EtaEventCategory | string, action: string, data?: EtaEventData) => void;
