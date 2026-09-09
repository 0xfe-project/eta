/**
 * btw side-channel (C8). A thread runs beside the main conversation:
 * contextual threads seed from the main session minus every visible
 * `eta.btw` message (so side chatter never compounds), tangent threads start
 * empty. Answered exchanges replay back as plain user/assistant pairs — one
 * transcript model, no second one. Persistence rides `eta.btw` CustomEntries;
 * handoff into the main run uses the same followUp driver as goals and loops.
 */

import type { AgentMessage } from "../types.ts";
import { BTW_CUSTOM_TYPE, type BtwPayload } from "./entries.ts";

export type BtwSaveState = "not-saved" | "queued" | "saved";

export interface BtwExchange {
	question: string;
	answer: string;
	at: number;
}

export interface BtwThread {
	id: string;
	kind: "contextual" | "tangent";
	exchanges: BtwExchange[];
	saveState: BtwSaveState;
	model?: string;
	thinking?: string;
	/** Bumped whenever an override forces the child session to be rebuilt. */
	assemblyVersion: number;
}

type BuildContext = (entries: unknown[], leafId: string | null) => { messages: AgentMessage[] };

function isVisibleBtw(entry: unknown): boolean {
	const e = entry as { role?: string; customType?: string };
	return e?.role === "custom" && e.customType === BTW_CUSTOM_TYPE;
}

export class BtwManager {
	private threads = new Map<string, BtwThread>();
	private sequence = 0;
	/** Seed cache per thread; contextual threads rebuild it from entries. */
	private seeds = new Map<string, AgentMessage[]>();

	private readonly buildContext: BuildContext;
	private readonly onVisibleNote?: (note: string) => void | Promise<void>;

	constructor(buildContext: BuildContext, onVisibleNote?: (note: string) => void | Promise<void>) {
		this.buildContext = buildContext;
		this.onVisibleNote = onVisibleNote;
	}

	create(kind: BtwThread["kind"], overrides: { model?: string; thinking?: string } = {}): BtwThread {
		const thread: BtwThread = {
			id: `btw-${++this.sequence}`,
			kind,
			exchanges: [],
			saveState: "not-saved",
			model: overrides.model,
			thinking: overrides.thinking,
			assemblyVersion: 1,
		};
		this.threads.set(thread.id, thread);
		return thread;
	}

	get(id: string): BtwThread | undefined {
		return this.threads.get(id);
	}

	list(): BtwThread[] {
		return [...this.threads.values()];
	}

	/** Seed = main-session context without any visible btw message; on context
	 * failure fall back to visible entries directly (both branches from pi-btw). */
	seedFrom(threadId: string, entries: unknown[], leafId: string | null): void {
		const thread = this.threads.get(threadId);
		if (thread === undefined || thread.kind !== "contextual") return;
		try {
			this.seeds.set(
				threadId,
				this.buildContext(entries, leafId).messages.filter((m) => !isVisibleBtw(m)),
			);
		} catch {
			this.seeds.set(
				threadId,
				entries.filter(
					(e) =>
						typeof (e as { role?: unknown }).role === "string" &&
						Array.isArray((e as { content?: unknown }).content) &&
						!isVisibleBtw(e),
				) as AgentMessage[],
			);
		}
	}

	/** What the side session sends: seed + answered Q/A pairs replayed inline. */
	messagesFor(threadId: string): AgentMessage[] {
		const thread = this.threads.get(threadId);
		if (thread === undefined) return [];
		const messages: AgentMessage[] = [...(this.seeds.get(threadId) ?? [])];
		for (const ex of thread.exchanges) {
			messages.push(
				{ role: "user", content: ex.question, timestamp: ex.at } as unknown as AgentMessage,
				{ role: "assistant", content: ex.answer, timestamp: ex.at + 1 } as unknown as AgentMessage,
			);
		}
		return messages;
	}

	answer(threadId: string, question: string, answer: string): void {
		this.threads.get(threadId)?.exchanges.push({ question, answer, at: Date.now() });
	}

	/**
	 * Save the thread's last exchange as a visible note in the main session.
	 * While the main run is busy the note queues and flushes at run end.
	 */
	save(threadId: string, running: boolean): BtwSaveState {
		const thread = this.threads.get(threadId);
		if (thread === undefined) return "not-saved";
		if (running) {
			thread.saveState = "queued";
			return thread.saveState;
		}
		void this.flushNote(thread);
		return thread.saveState;
	}

	/** Called at run boundaries: writes notes queued while the run was busy. */
	async flushQueued(): Promise<number> {
		let flushed = 0;
		for (const thread of this.threads.values()) {
			if (thread.saveState === "queued") {
				await this.flushNote(thread);
				flushed += 1;
			}
		}
		return flushed;
	}

	private async flushNote(thread: BtwThread): Promise<void> {
		const last = thread.exchanges[thread.exchanges.length - 1];
		if (last !== undefined) await this.onVisibleNote?.(`btw ${thread.id}: ${last.question} -> ${last.answer}`);
		thread.saveState = "saved";
	}

	/** FollowUp text handed to the main run (handoff = S1 driver). */
	handoff(threadId: string): string | undefined {
		const thread = this.threads.get(threadId);
		if (thread === undefined || thread.exchanges.length === 0) return undefined;
		return `[btw ${thread.id}] side thread has results: fold them in or summarize for the user.`;
	}

	/** Override changes rebuild the child session but never lose the thread. */
	setOverride(threadId: string, overrides: { model?: string; thinking?: string }): void {
		const thread = this.threads.get(threadId);
		if (thread === undefined) return;
		if (overrides.model !== undefined && overrides.model !== thread.model) thread.assemblyVersion += 1;
		if (overrides.thinking !== undefined && overrides.thinking !== thread.thinking) thread.assemblyVersion += 1;
		thread.model = overrides.model ?? thread.model;
		thread.thinking = overrides.thinking ?? thread.thinking;
	}

	/** Re-register threads from a replayed `eta.btw` entry log. */
	replay(entries: { customType: string; payload: unknown }[]): void {
		for (const entry of entries) {
			if (entry.customType !== BTW_CUSTOM_TYPE) continue;
			const payload = entry.payload as BtwPayload & Partial<BtwThread>;
			if (typeof payload?.note !== "string") continue;
			const id = payload.id ?? `btw-replay-${++this.sequence}`;
			const existing = this.threads.get(id);
			if (existing === undefined) {
				this.threads.set(id, {
					id,
					kind: payload.kind ?? "tangent",
					exchanges: payload.exchanges ?? [],
					saveState: payload.saveState ?? "saved",
					model: payload.model,
					thinking: payload.thinking,
					assemblyVersion: payload.assemblyVersion ?? 1,
				});
			}
		}
	}
}
