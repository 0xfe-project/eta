/**
 * The only three channels between core and the GUI (GUI-PLAN G0.1): the
 * SessionView truth channel, the AgentEvent interaction channel, and the
 * telemetry dev ring. Everything here is JSON-safe; the GUI must never touch
 * core internals beyond these frames.
 */

import type { HarnessEventPayload, JsonValue, SessionView } from "@eta/core";

export interface DevFrame {
	ts: number;
	session: string;
	category: string;
	action: string;
	data: JsonValue;
}

export type ChannelFrame =
	| { channel: "view"; view: SessionView }
	| { channel: "agent"; event: HarnessEventPayload }
	| { channel: "dev"; frame: DevFrame };

/** Per-session ring of the last N telemetry frames; full ring replays on attach. */
export class DevRing {
	private frames: DevFrame[] = [];
	private next = 0;
	private filled = false;

	private readonly capacity: number;

	constructor(capacity = 512) {
		this.capacity = capacity;
	}

	push(frame: DevFrame): void {
		this.frames[this.next] = frame;
		this.next = (this.next + 1) % this.capacity;
		if (this.next === 0) this.filled = true;
	}

	tail(filter?: string): DevFrame[] {
		const ordered = this.filled ? [...this.frames.slice(this.next), ...this.frames.slice(0, this.next)] : this.frames.slice();
		const needle = filter?.trim().toLowerCase();
		if (needle === undefined || needle === "") return ordered;
		return ordered.filter((f) => f.category.toLowerCase().includes(needle) || f.action.toLowerCase().includes(needle));
	}
}

export function encodeFrame(frame: ChannelFrame): string {
	return JSON.stringify(frame);
}

export function decodeFrame(raw: string): ChannelFrame {
	return JSON.parse(raw) as ChannelFrame;
}
