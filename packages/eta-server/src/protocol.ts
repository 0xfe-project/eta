/**
 * Server-side wire runtime: the JSON codec, the telemetry ring, and the
 * transcript signature that decides full-vs-patch. The frame and op types live
 * in @eta/core (`wire.ts`) and are re-exported here for the host/server.
 */

import type {
	ChannelFrame,
	ClientMessage,
	ControlOp,
	DevFrame,
	GuiOp,
	ServerMessage,
	SessionView,
	SessionViewPatch,
	SidebarSession,
} from "@eta/core";

export type {
	ChannelFrame,
	ClientMessage,
	ControlOp,
	DevFrame,
	GuiOp,
	ServerMessage,
	SessionViewPatch,
	SidebarSession,
};
export { HEAVY_VIEW_FIELDS } from "@eta/core";

/**
 * What the entry-derived halves of a view depend on, reduced to a handful of
 * scalars: the branch tip, the compaction epoch, and how many rows each of the
 * three heavy lists holds. A view whose fingerprint did not move carries the
 * same transcript, so a frame may leave the transcript out entirely.
 *
 * Deliberately cheap: computing it must not cost what serializing the view costs.
 */
export function viewFingerprint(view: SessionView): string {
	const tail = view.messages[view.messages.length - 1];
	return [
		view.branch?.tipId ?? "",
		view.compactionEpoch,
		view.messages.length,
		view.systems.length,
		view.thinking.length,
		tail?.seq ?? 0,
	].join("|");
}

/** The view without its transcript: everything a frame may carry after the first. */
export function viewPatch(view: SessionView): SessionViewPatch {
	const { messages: _messages, systems: _systems, thinking: _thinking, ...rest } = view;
	return rest;
}

/** Per-session ring of the last N telemetry frames; full ring replays on attach. */
export class DevRing {
	private frames: DevFrame[] = [];
	private next = 0;
	private filled = false;

	private readonly capacity: number;

	constructor(capacity = 512) {
		this.capacity = capacity;
	}

	seed(frames: DevFrame[]): void {
		for (const frame of frames) this.push(frame);
	}

	push(frame: DevFrame): void {
		this.frames[this.next] = frame;
		this.next = (this.next + 1) % this.capacity;
		if (this.next === 0) this.filled = true;
	}

	tail(filter?: string): DevFrame[] {
		const ordered = this.filled
			? [...this.frames.slice(this.next), ...this.frames.slice(0, this.next)]
			: this.frames.slice();
		const needle = filter?.trim().toLowerCase();
		if (needle === undefined || needle === "") return ordered;
		return ordered.filter(
			(f) => f.category.toLowerCase().includes(needle) || f.action.toLowerCase().includes(needle),
		);
	}
}

export function encodeMessage(message: ServerMessage): string {
	return JSON.stringify(message);
}

export function decodeClientMessage(raw: string): ClientMessage {
	return JSON.parse(raw) as ClientMessage;
}
