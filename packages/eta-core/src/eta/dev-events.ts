/**
 * The dev event stream: what a debug panel, log sink, or teach/self-evolution
 * recorder consumes. Separate from the UI-facing event projection. Old core had
 * fourteen categories; eta keeps them all and adds `btw`.
 */

export const DEV_CATEGORIES = [
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

export type DevCategory = (typeof DEV_CATEGORIES)[number];

export interface DevEventData {
	[key: string]: unknown;
}

export interface DevEvent {
	seq: number;
	ts: number;
	agentId: string;
	category: DevCategory | string;
	action: string;
	data: DevEventData;
}

export type DevEmit = (category: DevCategory | string, action: string, data?: DevEventData) => void;

/** Fan-out bus; batteries and the harness bridge both emit here. */
export class DevEventBus {
	private seq = 0;
	private readonly listeners = new Set<(event: DevEvent) => void>();
	readonly agentId: string;
	private readonly clock: () => number;

	constructor(agentId: string, clock: () => number = () => Date.now()) {
		this.agentId = agentId;
		this.clock = clock;
	}

	emit: DevEmit = (category, action, data) => {
		this.seq += 1;
		const event: DevEvent = {
			seq: this.seq,
			ts: this.clock(),
			agentId: this.agentId,
			category,
			action,
			data: data ?? {},
		};
		for (const listener of [...this.listeners]) listener(event);
	};

	subscribe(listener: (event: DevEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

/** In-memory sink: keeps everything the bus emitted, for tests and the dev panel buffer. */
export class MemoryDevEventSink {
	readonly events: DevEvent[] = [];

	constructor(bus: DevEventBus) {
		bus.subscribe((event) => this.events.push(event));
	}

	of(category: DevCategory | string, action?: string): DevEvent[] {
		return this.events.filter((e) => e.category === category && (action === undefined || e.action === action));
	}

	categories(): Set<string> {
		return new Set(this.events.map((e) => e.category));
	}

	all(): DevEvent[] {
		return [...this.events];
	}
}
