/**
 * The inbox — how the outside world reaches the turn loop (REFACTOR.md §2.5,
 * ported from eta-agent's lane inbox + selectAcceptedInbox + planBoundaryInbox).
 *
 * Three kinds, three moments:
 * - `steer`: consumed at the next run boundary, so the run in flight changes
 *   course instead of being interrupted mid-turn.
 * - `followUp`: consumed only when a run would otherwise stop — it continues a
 *   run that has nothing else to do, and never competes with real work.
 * - `nextRun`: consumed when the next run starts, whatever happens to this one.
 *
 * Both queue modes (`all` / `one-at-a-time`) apply per kind, so a user can
 * keep several follow-ups in reserve while steering takes effect immediately.
 */
import type { ImageContent } from "@earendil-works/pi-ai";
import type { QueueMode } from "../types/config.ts";
import type { AgentMessage } from "../types/messages.ts";

export type QueueKind = "steer" | "followUp" | "nextRun";

export interface QueuedItem {
	entryId: string;
	kind: QueueKind;
	message: AgentMessage;
}

export type InvalidMessageReason = "empty" | "pending_assistant" | "images_with_non_user";

/** A queued input the inbox refuses; the reason is part of the contract. */
export class InvalidMessage extends Error {
	readonly reason: InvalidMessageReason;

	constructor(reason: InvalidMessageReason, message: string) {
		super(message);
		this.name = "InvalidMessage";
		this.reason = reason;
	}
}

let counter = 0;
function nextEntryId(): string {
	counter += 1;
	return `queued-${counter.toString(36)}-${Date.now().toString(36)}`;
}

/**
 * Normalize and validate a queued input (eta-agent's enqueue checks, kept
 * verbatim in spirit): text or an image is required, a half-streamed assistant
 * message cannot be queued, and images attach only to user messages.
 */
export function normalizeQueuedInput(input: string | AgentMessage, images?: readonly ImageContent[]): AgentMessage {
	const timestamp = Date.now();
	if (typeof input === "string") {
		if (input.length === 0 && (images === undefined || images.length === 0)) {
			throw new InvalidMessage("empty", "Queued input must contain text or an image");
		}
		return {
			role: "user",
			content: [...(input.length === 0 ? [] : [{ type: "text" as const, text: input }]), ...(images ?? [])],
			timestamp,
		};
	}
	if (input.role === "assistant" && (input as { stopReason?: string }).stopReason === "pending") {
		throw new InvalidMessage("pending_assistant", "Cannot queue a pending assistant message");
	}
	if (images !== undefined && images.length > 0 && input.role !== "user") {
		throw new InvalidMessage("images_with_non_user", "Images can be added only to queued user messages");
	}
	if (images === undefined || images.length === 0 || input.role !== "user") {
		return structuredClone(input);
	}
	const content = input.content;
	return {
		...structuredClone(input),
		content: [
			...(typeof content === "string"
				? content.length === 0
					? []
					: [{ type: "text" as const, text: content }]
				: content),
			...images,
		],
	};
}

export interface InboxOptions {
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
}

export class Inbox {
	private items: QueuedItem[] = [];
	private steeringMode: QueueMode = "all";
	private followUpMode: QueueMode = "all";

	/** Keep the modes in step with the configuration the runner reads live. */
	configure(options: InboxOptions): void {
		if (options.steeringMode !== undefined) this.steeringMode = options.steeringMode;
		if (options.followUpMode !== undefined) this.followUpMode = options.followUpMode;
	}

	/** Queue an input. Throws `InvalidMessage` when it cannot be queued. */
	enqueue(kind: QueueKind, input: string | AgentMessage, images?: readonly ImageContent[]): QueuedItem {
		const item: QueuedItem = { entryId: nextEntryId(), kind, message: normalizeQueuedInput(input, images) };
		this.items.push(item);
		return item;
	}

	/** Drop a queued item; false when it was already consumed. */
	cancel(entryId: string): boolean {
		const index = this.items.findIndex((item) => item.entryId === entryId);
		if (index === -1) return false;
		this.items.splice(index, 1);
		return true;
	}

	list(): QueuedItem[] {
		return this.items.slice();
	}

	get depth(): number {
		return this.items.length;
	}

	/**
	 * What a run takes when it starts: `nextRun` always, `steer` and `followUp`
	 * subject to their modes. Order is preserved, so the run sees the messages in
	 * the order they were queued.
	 */
	accept(): QueuedItem[] {
		return this.take((item) => {
			if (item.kind === "nextRun") return true;
			if (item.kind === "steer") return this.steeringMode === "all" || this.firstOfKind("steer", item);
			return this.followUpMode === "all" || this.firstOfKind("followUp", item);
		});
	}

	/**
	 * What a boundary takes: steering first, and follow-ups only when nothing
	 * else will continue the run (`followUpWhenNoTrigger`).
	 */
	takeAtBoundary(options: { followUpWhenNoTrigger: boolean }): { steers: QueuedItem[]; followUps: QueuedItem[] } {
		const steers = this.take(
			(item) => item.kind === "steer" && (this.steeringMode === "all" || this.firstOfKind("steer", item)),
		);
		if (!options.followUpWhenNoTrigger) return { steers, followUps: [] };
		const followUps = this.take(
			(item) => item.kind === "followUp" && (this.followUpMode === "all" || this.firstOfKind("followUp", item)),
		);
		return { steers, followUps };
	}

	/** Take every item matching the predicate, preserving order. */
	private take(predicate: (item: QueuedItem) => boolean): QueuedItem[] {
		const taken: QueuedItem[] = [];
		const remainder: QueuedItem[] = [];
		for (const item of this.items) {
			if (predicate(item)) taken.push(item);
			else remainder.push(item);
		}
		this.items = remainder;
		return taken;
	}

	/** Whether this item is the earliest of its kind still queued. */
	private firstOfKind(kind: QueueKind, item: QueuedItem): boolean {
		return this.items.find((candidate) => candidate.kind === kind)?.entryId === item.entryId;
	}
}
