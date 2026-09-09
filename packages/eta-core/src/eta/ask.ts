/**
 * ask_user battery (C3/S5). Schema learned from pi's ask-user, persistence is
 * ours: every ask is recorded as an `eta.ask` CustomEntry and every answer as
 * `eta.answer`, so a killed process can replay the entry log, re-surface the
 * unanswered question, and backfill the tool call that is still waiting.
 */

import { Type } from "typebox";
import { awaitWithContext } from "../harness/context.ts";
import type { AgentHarnessTool } from "../harness/types.ts";
import type { DevEmit } from "./dev-events.ts";
import { ASK_CUSTOM_TYPE, type AskPayload } from "./entries.ts";

export type AskResponse =
	| { kind: "selection"; selections: string[]; comment?: string }
	| { kind: "freeform"; text: string }
	| { kind: "none" };

interface PendingAsk {
	payload: AskPayload;
	settle(response: AskResponse): void;
}

export class AskRegistry {
	private pending = new Map<string, PendingAsk>();
	private readonly dev: DevEmit | undefined;

	constructor(opts: { dev?: DevEmit } = {}) {
		this.dev = opts.dev;
	}

	/** The tool waits on this; abort/timeout resolve to "none", never hang. */
	ask(payload: AskPayload, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<AskResponse> {
		return new Promise<AskResponse>((resolve) => {
			let done = false;
			const settle = (response: AskResponse, action: string) => {
				if (done) return;
				done = true;
				this.pending.delete(payload.questionId);
				if (timer !== undefined) clearTimeout(timer);
				opts.signal?.removeEventListener("abort", onAbort);
				this.dev?.("ask_user", action, { questionId: payload.questionId, kind: response.kind });
				resolve(response);
			};
			let timer: ReturnType<typeof setTimeout> | undefined;
			if (opts.timeoutMs !== undefined) {
				timer = setTimeout(() => settle({ kind: "none" }, "expired"), opts.timeoutMs);
				timer.unref?.();
			}
			const onAbort = () => settle({ kind: "none" }, "canceled");
			opts.signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(payload.questionId, { payload, settle: (response) => settle(response, "answered") });
			this.dev?.("ask_user", "asked", { questionId: payload.questionId });
		});
	}

	/** Questions still waiting for a human — what the UI re-surfaces on boot. */
	pendingAsks(): AskPayload[] {
		return [...this.pending.values()].map((p) => p.payload);
	}

	/** Backfill one waiting ask; false when nobody is waiting on that id. */
	answer(questionId: string, response: AskResponse): boolean {
		const waiting = this.pending.get(questionId);
		if (waiting === undefined) return false;
		waiting.settle(response);
		return true;
	}

	/**
	 * Re-register unanswered asks from a replayed entry log (ask entries with
	 * no later answer for the same questionId). The re-driven tool call will
	 * call ask() again for the same questionId; until then this is what makes
	 * the pending question visible to the UI after a restart.
	 */
	replay(entries: { customType: string; payload: unknown }[]): void {
		const answered = new Set<string>();
		const asks: AskPayload[] = [];
		for (const entry of entries) {
			if (entry.customType === ASK_CUSTOM_TYPE) {
				asks.push(entry.payload as AskPayload);
			} else if (entry.customType === "eta.answer") {
				answered.add((entry.payload as { questionId: string }).questionId);
			}
		}
		for (const payload of asks) {
			if (!answered.has(payload.questionId) && !this.pending.has(payload.questionId)) {
				this.pending.set(payload.questionId, { payload, settle: () => {} });
			}
		}
	}
}

/** Proxy-safe option keys: models sometimes rewrite option fields to label/text/value/name. */
export function normalizeAskOptions(raw: unknown): { title: string; description?: string }[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	return raw.map((item) => {
		if (typeof item === "string") return { title: item };
		const o = item as Record<string, unknown>;
		const title = [o.title, o.label, o.text, o.value, o.name].find((v) => typeof v === "string");
		const description = [o.description, o.detail, o.desc].find((v) => typeof v === "string");
		return { title: title ?? JSON.stringify(o), ...(description !== undefined ? { description } : {}) };
	});
}

export function askResponseText(response: AskResponse): string {
	switch (response.kind) {
		case "selection":
			return `Selected: ${response.selections.join(", ")}${response.comment === undefined ? "" : ` — ${response.comment}`}`;
		case "freeform":
			return response.text;
		case "none":
			return "No answer from the user.";
	}
}

const askSchema = Type.Object({
	question: Type.String({ description: "What you need to know, phrased plainly" }),
	context: Type.Optional(Type.String({ description: "Why you're asking, if not obvious" })),
	options: Type.Optional(
		Type.Array(
			Type.Object({
				title: Type.String({ description: "Short label for this choice" }),
				description: Type.Optional(Type.String({ description: "What this choice means" })),
			}),
		),
	),
	allowMultiple: Type.Optional(Type.Boolean({ description: "Let the user pick more than one option" })),
	allowFreeform: Type.Optional(Type.Boolean({ description: "Let the user answer in their own words" })),
});

export interface AskUserToolDeps {
	registry: AskRegistry;
	/** Persist the `eta.ask` entry (harness.appendCustomEntry) before waiting. */
	onAsk?(payload: AskPayload): void | Promise<void>;
	/** Deadline for a human answer; expired = "none". */
	timeoutMs?: number;
}

export function createAskUserTool(
	deps: AskUserToolDeps,
): AgentHarnessTool<object | undefined, typeof askSchema, AskResponse | undefined> {
	return {
		name: "ask_user",
		label: "ask_user",
		description:
			"Ask the user one question and wait for the answer. Use only when you genuinely can't pick a reasonable default yourself.",
		parameters: askSchema,
		replay: "safe",
		async execute(_toolCallId, params, _onUpdate, _toolContext, invocation, context) {
			const options = normalizeAskOptions((params as { options?: unknown }).options);
			const remembered = (await invocation.getMemo("eta.ask")) as AskPayload | undefined;
			const payload: AskPayload = remembered ?? {
				questionId: invocation.invocationId,
				question: params.question,
				options: options?.map((o) => o.title),
				multi: params.allowMultiple,
			};
			if (remembered === undefined) await invocation.setMemo("eta.ask", payload as never);
			await deps.onAsk?.(payload);
			const response = await awaitWithContext(
				deps.registry.ask(payload, { timeoutMs: deps.timeoutMs, signal: context.abortSignal }),
				context,
			).catch(() => ({ kind: "none" }) as const);
			return { content: [{ type: "text" as const, text: askResponseText(response) }], details: response };
		},
	};
}
