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
 * It lives in the harness rather than the kernel because deciding takes
 * arithmetic (`estimation.ts`), and the kernel counts no tokens. What the
 * kernel's runner sees is only the `CompactionDriver` seam: `attach()`,
 * `threshold()`, `overflow()`.
 *
 * What the runner keeps is the context seam (§3 ruling 4): `readContext()` and
 * `replaceContext()`. The service reads the context, decides, asks the
 * summarizer plugin for a summary, and hands the replacement back.
 *
 * The entries a cut is taken on come from the journaling service — the journal
 * has exactly one owner, and this is not it.
 *
 * The summarization itself (prompt, model call, incremental summaries) is a
 * plugin behind `CompactionSummarizer`; the harness ships no summary text.
 *
 * Failure semantics: a driver that was attached and then has nothing to
 * summarize *with* is a wiring bug, not a quiet no-op. Missing summarizer,
 * missing run, missing model — each throws. `false` means one of two honest
 * answers: "the history still fits" (threshold) or "the summarizer looked and
 * declined" (a summarizer that returns nothing), and "this run already spent
 * its one overflow recovery". Silence is never an answer.
 */
import {
	type CompactionDriver,
	type CompactionHost,
	type CompactionOutcome,
	type CompactionReason,
	type CompactionSummarizer,
	type ConfigService,
	type Emit,
	type Entry,
	kernelEmit,
	kernelOn,
} from "@eta/core";
import { type Context, Service } from "cordis";
import { estimateContextTokens, fitCompactionSettings, shouldCompact } from "./estimation";

/**
 * Where a compaction service reads the branch from — the journaling service,
 * which owns the journal (REFACTOR.md §2.4). Structural on purpose: the
 * service needs entries, not the journal.
 */
export interface CompactionEntrySource {
	entries(): readonly Entry[];
}

/**
 * A compaction signal arrived and nothing can handle it: no summarizer, no run
 * attached, or no model to summarize with. Thrown rather than declined, so a
 * half-wired session dies where the mistake is instead of resending a history
 * nobody is keeping in bounds.
 */
export class CompactionMisconfigured extends Error {
	readonly code = "compaction_misconfigured";

	constructor(reason: string) {
		super(`compaction_misconfigured: ${reason}`);
		this.name = "CompactionMisconfigured";
	}
}

export interface CompactionServiceOptions {
	config: ConfigService;
	/** The journal's owner; cut points are indices into its entries. */
	journaling: CompactionEntrySource;
	/**
	 * The summarizer plugin. Optional only so an assembly can build the service
	 * before deciding; a signal without one throws (see the class docs).
	 */
	summarizer?: CompactionSummarizer;
	/** Called when a summarizer throws; the run continues either way. */
	warn?: (message: string) => void;
}

export class CompactionService extends Service implements CompactionDriver {
	static readonly provide = "compaction";

	private readonly config: ConfigService;
	private readonly journaling: CompactionEntrySource;
	private readonly summarizer: CompactionSummarizer | undefined;
	private readonly warn: (message: string) => void;
	private readonly emit: Emit;
	private host: CompactionHost | undefined;
	/** One overflow recovery per run: a second overflow is a real failure. */
	private overflowRecoveryUsed = false;

	constructor(ctx: Context, options: CompactionServiceOptions) {
		super(ctx, "compaction");
		this.config = options.config;
		this.journaling = options.journaling;
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

	/** Whether this service can compact at all: a summarizer and a run behind it. */
	get available(): boolean {
		return this.summarizer !== undefined && this.host !== undefined;
	}

	/** Someone asked for a compaction; do it regardless of the threshold. */
	async manual(instructions?: string): Promise<boolean> {
		return this.run("manual", { force: true, ...(instructions === undefined ? {} : { instructions }) });
	}

	/** Compact when the history no longer fits the model that owns it. */
	async threshold(): Promise<boolean> {
		return this.run("threshold", { force: false });
	}

	/** A request overflowed: cut the history once, then let the caller retry. */
	async overflow(): Promise<boolean> {
		// The spent budget is a real answer, not a misconfiguration: the run has
		// already used its one recovery and a second overflow is a genuine failure.
		if (this.overflowRecoveryUsed) return false;
		this.overflowRecoveryUsed = true;
		return this.run("overflow", { force: true });
	}

	private async run(reason: CompactionReason, options: { force: boolean; instructions?: string }): Promise<boolean> {
		const summarizer = this.summarizer;
		if (summarizer === undefined) {
			throw new CompactionMisconfigured(
				`${reason}() was asked to compact, but no summarizer is wired: install one (for instance @eta/compaction) or leave the driver off`,
			);
		}
		const host = this.host;
		if (host === undefined) {
			throw new CompactionMisconfigured(`${reason}() was asked to compact, but no run is attached to this service`);
		}
		const request = host.request();
		const model = request.model;
		if (model === undefined) {
			throw new CompactionMisconfigured(
				`${reason}() was asked to compact, but the session's model does not resolve`,
			);
		}

		const settings = fitCompactionSettings(this.config.read("compaction"), model);
		const estimate = estimateContextTokens(host.readContext());
		if (!options.force && !shouldCompact(estimate.tokens, model.contextWindow, settings)) return false;

		const runId = request.runId;
		this.emit("compaction:start", { runId, reason, startedAt: Date.now() });
		let outcome: CompactionOutcome | undefined;
		try {
			outcome = await summarizer.summarize({
				reason,
				...(options.instructions === undefined ? {} : { customInstructions: options.instructions }),
				messages: host.readContext(),
				entries: this.journaling.entries(),
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
			...(outcome.details === undefined ? {} : { details: outcome.details }),
			retainedTail: [...outcome.retainedTail],
			tokensBefore: outcome.tokensBefore,
			...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
		});
		return true;
	}
}
