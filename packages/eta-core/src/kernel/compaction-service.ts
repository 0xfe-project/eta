/**
 * CompactionService — the compaction decision and protocol (REFACTOR.md §2.4,
 * §3 ruling 4).
 *
 * Compaction has three reasons to happen, and they are the whole of its public
 * surface:
 * - `manual()`   — someone asked for it (a `/compact` command, the host).
 * - `threshold()` — the history no longer fits the model that owns it. Decided
 *                   here, not in the runner: the runner knows when a run
 *                   starts, not what fits.
 * - `overflow()` — a request just failed because it was too large. One recovery
 *                   per run, enforced here, so the runner cannot forget it.
 *
 * What stays in the runner is the seam (§3 ruling 4): `readContext()` and
 * `replaceContext()`. The service reads the context, decides, asks the
 * summarizer plugin for a summary, and hands the replacement back. The runner
 * keeps two lines — a threshold check before its first request, an overflow
 * recovery in its retry loop — and knows nothing else about compaction.
 *
 * The summarization itself (prompt, model call, incremental summaries) is a
 * plugin behind `CompactionSummarizer`; the kernel ships no summary text.
 */
import type { Api, AssistantMessage, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { type Context, Service } from "cordis";
import type { Entry } from "../types/entries";
import type { Emit } from "../types/events";
import { kernelEmit, kernelOn } from "../types/events";
import type { AgentMessage, ThinkingLevel } from "../types/messages";
import {
	type CompactionOutcome,
	type CompactionReason,
	type CompactionSummarizer,
	estimateContextTokens,
	fitCompactionSettings,
	shouldCompact,
} from "./compaction";
import type { ConfigService } from "./config";

/** The run's facts, as the compaction service needs them; the runner provides them. */
export interface CompactionRequestState {
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel;
	streamOptions?: SimpleStreamOptions | undefined;
	/** Aborts the summarization with the run. */
	signal: AbortSignal;
	runId: string;
	/** The model call, wired by whoever owns the models seam. */
	ask: (prompt: { systemPrompt?: string; messages: AgentMessage[] }) => Promise<AssistantMessage>;
}

/** What the service needs from the run in flight; the runner implements it. */
export interface CompactionHost {
	/** The messages a request would carry right now (a copy). */
	readContext(): AgentMessage[];
	/** Swap the context for a summary plus the tail that is kept. */
	replaceContext(summary: string, options: { retainedTail?: readonly AgentMessage[]; tokensBefore?: number }): void;
	/** The branch entries behind the context, for cut-point selection. */
	entries(): readonly Entry[];
	/** What this run's request would carry, read live. */
	request(): CompactionRequestState;
}

export interface CompactionServiceOptions {
	config: ConfigService;
	/** The summarizer plugin. Without one, every signal declines. */
	summarizer?: CompactionSummarizer;
	/** Called when a summarizer throws; the run continues either way. */
	warn?: (message: string) => void;
}

export class CompactionService extends Service {
	static readonly provide = "compaction";

	private readonly config: ConfigService;
	private readonly summarizer: CompactionSummarizer | undefined;
	private readonly warn: (message: string) => void;
	private readonly emit: Emit;
	private host: CompactionHost | undefined;
	/** One overflow recovery per run: a second overflow is a real failure. */
	private overflowRecoveryUsed = false;

	constructor(ctx: Context, options: CompactionServiceOptions) {
		super(ctx, "compaction");
		this.config = options.config;
		this.summarizer = options.summarizer;
		this.warn = options.warn ?? (() => undefined);
		this.emit = kernelEmit(ctx);
		// A run starts with the recovery budget restored; the runner never has to
		// remember to tell us.
		kernelOn(ctx)("turn:run-start", () => {
			this.overflowRecoveryUsed = false;
		});
	}

	/** The runner registers the context it owns (ruling 4). */
	attach(host: CompactionHost): void {
		this.host = host;
	}

	/** Whether a summarizer is available at all. */
	get available(): boolean {
		return this.summarizer !== undefined && this.host !== undefined;
	}

	/** Someone asked for a compaction; do it regardless of the threshold. */
	async manual(): Promise<boolean> {
		return this.run("manual", { force: true });
	}

	/** Compact when the history no longer fits the model that owns it. */
	async threshold(): Promise<boolean> {
		return this.run("threshold", { force: false });
	}

	/** A request overflowed: cut the history once, then let the caller retry. */
	async overflow(): Promise<boolean> {
		if (!this.available || this.overflowRecoveryUsed) return false;
		this.overflowRecoveryUsed = true;
		return this.run("overflow", { force: true });
	}

	private async run(reason: CompactionReason, options: { force: boolean }): Promise<boolean> {
		const host = this.host;
		const summarizer = this.summarizer;
		if (host === undefined || summarizer === undefined) return false;
		const request = host.request();
		const model = request.model;
		if (model === undefined) return false;

		const settings = fitCompactionSettings(this.config.read("compaction"), model);
		const estimate = estimateContextTokens(host.readContext());
		if (!options.force && !shouldCompact(estimate.tokens, model.contextWindow, settings)) return false;

		const runId = request.runId;
		this.emit("compaction:start", { runId, reason, startedAt: Date.now() });
		let outcome: CompactionOutcome | undefined;
		try {
			outcome = await summarizer.summarize({
				reason,
				messages: host.readContext(),
				entries: host.entries(),
				settings,
				contextWindow: model.contextWindow,
				estimatedTokens: estimate.tokens,
				model: model as never,
				thinkingLevel: request.thinkingLevel,
				streamOptions: request.streamOptions as never,
				signal: request.signal,
				ask: request.ask,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.warn(`[eta-compaction] summarizer failed: ${message}`);
			this.emit("compaction:end", {
				runId,
				reason,
				endedAt: Date.now(),
				status: "failed",
				error: message,
			});
			return false;
		}

		if (outcome === undefined) {
			this.emit("compaction:end", { runId, reason, endedAt: Date.now(), status: "declined" });
			return false;
		}

		host.replaceContext(outcome.summary, {
			retainedTail: outcome.retainedTail,
			tokensBefore: outcome.tokensBefore,
		});
		// The journaling subscriber writes the entry from this payload, which is
		// why the event carries the summary rather than an id it cannot know.
		this.emit("compaction:end", {
			runId,
			reason,
			endedAt: Date.now(),
			status: "completed",
			summary: outcome.summary,
			retainedTail: [...outcome.retainedTail],
			tokensBefore: outcome.tokensBefore,
			...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
		});
		return true;
	}
}
