/**
 * Whether a compaction is worth paying for — pure arithmetic, no session, no clock.
 *
 * Compaction is not free. Whatever survives gets re-written into the provider's
 * prompt cache at the write price, and only later requests get to read it back
 * cheaply. So the question is never "is the context big" but "will this session
 * run long enough after the cut to earn the rewrite back":
 *
 *     breakevenRequests = writeTokens * (cacheWriteReadRatio - 1) / (archiveTokens - memoTokens)
 *
 * compact when the context is about to hit the window anyway, or when that number
 * fits inside the number of requests the session is expected to still run.
 *
 * Three deliberate choices in this port:
 *
 * - The first compaction is given `firstCompactionRequestScale` times the horizon:
 *   one uncertain estimate deserves the benefit of the doubt, and a context that
 *   has never been cut is usually the expensive one. Every later cut has to beat
 *   `subsequentCompactionMargin` — repeated compaction against a short horizon is
 *   how a session pays rewrite after rewrite and never gets the reads back.
 * - A compaction's cost is carried as debt and repaid by the savings of each
 *   following request, so the next decision sees the last one's bill.
 * - No standard-deviation knob. The upstream version shipped one, defaulted it to
 *   off, and never turned it on; a dial nobody turns is just code that can rot.
 *
 * The reason enum exists because a compaction that did not happen is invisible
 * otherwise: the GUI has to be able to say "not yet, here is the number".
 */

export interface CompactionEconomics {
	/** What a cache write costs next to a cache read. 12.5 = 1.25x write against 0.1x read. */
	cacheWriteReadRatio: number;
	/** The first cut may act on a horizon this many times longer than the estimate. */
	firstCompactionRequestScale: number;
	/** Later cuts need this much margin over breakeven before they fire. */
	subsequentCompactionMargin: number;
}

export const DEFAULT_COMPACTION_ECONOMICS: CompactionEconomics = Object.freeze({
	cacheWriteReadRatio: 12.5,
	firstCompactionRequestScale: 2,
	subsequentCompactionMargin: 1.5,
});

/** Why this compaction happened, or why it did not. */
export type CompactionReason =
	| "economic"
	| "window_protection"
	| "deferred_economic"
	| "deferred_subsequent_margin"
	| "deferred_carried_debt"
	| "horizon_unavailable"
	| "cache_ratio_unavailable"
	| "non_positive_saving"
	/** Left for the caller: the decision is open, but no cut point can be placed. */
	| "cut_point_unavailable";

export interface RequestHorizon {
	/** Requests observed between finished boundaries. */
	requestsPerBoundaryMean: number;
	/** Expected requests from here, already capped by whatever the window allows. */
	expectedRemainingRequests: number;
	/** Requests that fit before the window fills, when the growth rate is known. */
	windowRequestUpperBound: number | null;
	averageContextTokenIncrement: number | null;
}

function positiveFinite(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegativeFinite(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function estimateRequestHorizon(input: {
	completedBoundaryRequestCounts: readonly number[];
	remainingBoundaries: number;
	contextTokens: number;
	contextWindowTokens: number | null;
	averageContextTokenIncrement: number | null;
}): RequestHorizon {
	const observed = input.completedBoundaryRequestCounts.filter(
		(count): count is number => typeof count === "number" && Number.isFinite(count) && count >= 0,
	);
	const mean = observed.reduce((total, count) => total + count, 0) / Math.max(1, observed.length);
	const remaining = Math.max(0, input.remainingBoundaries);
	const fromHistory = 1 + Math.floor(mean * remaining);
	const increment = nonNegativeFinite(input.averageContextTokenIncrement);
	const windowTokens = positiveFinite(input.contextWindowTokens);
	const windowRequestUpperBound =
		windowTokens === null || increment === null || increment <= 0
			? null
			: Math.max(0, Math.floor((windowTokens - input.contextTokens) / increment));
	return {
		requestsPerBoundaryMean: mean,
		averageContextTokenIncrement: increment,
		windowRequestUpperBound,
		expectedRemainingRequests:
			windowRequestUpperBound === null
				? fromHistory
				: Math.min(fromHistory, windowRequestUpperBound),
	};
}

export interface CompactionPricingInput {
	/** Context tokens the rewrite puts back into the cache: this is the price. */
	writeTokens: number;
	/** Tokens about to leave the context. */
	archiveTokens: number;
	/** Tokens the summary costs in exchange for them. */
	memoTokens: number;
	contextTokens: number;
	contextWindowTokens: number | null;
	/** Window held back for the answer; the hard floor that ignores price. */
	reserveTokens: number;
	/** Requests observed between finished task boundaries; null = no history yet. */
	completedBoundaryRequestCounts: readonly number[] | null;
	remainingBoundaries: number;
	averageContextTokenIncrement: number | null;
	priorCompactionCount: number;
	/** Rewrite cost the last compaction left unpaid. */
	carriedDebtTokens: number;
	/** Savings already credited against that debt. */
	cacheDebtRepaymentTokens: number;
	economics: CompactionEconomics;
}

export interface CompactionDecision {
	compact: boolean;
	reason: CompactionReason;
	/** Context tokens the rewrite pays the cache-write price for. */
	writeTokens: number;
	/** What the cut saves per request, once the summary's own cost is paid. */
	savingTokens: number;
	breakevenRequests: number | null;
	combinedBreakevenRequests: number | null;
	effectiveHorizonRequests: number | null;
	horizon: RequestHorizon | null;
	incrementalCacheCostRatio: number;
	carriedDebtTokens: number;
	priorCompactionCount: number;
}

/** Decide one compaction. Reads inputs, changes nothing, never awaits. */
export function decideCompaction(input: CompactionPricingInput): CompactionDecision {
	const economics = input.economics;
	const costRatio = Math.max(0, economics.cacheWriteReadRatio - 1);
	const savingTokens = input.archiveTokens - input.memoTokens;
	const horizon =
		input.completedBoundaryRequestCounts === null
			? null
			: estimateRequestHorizon({
					completedBoundaryRequestCounts: input.completedBoundaryRequestCounts,
					remainingBoundaries: input.remainingBoundaries,
					contextTokens: input.contextTokens,
					contextWindowTokens: input.contextWindowTokens,
					averageContextTokenIncrement: input.averageContextTokenIncrement,
				});

	const breakeven = savingTokens > 0 ? (input.writeTokens * costRatio) / savingTokens : null;
	const unpaidDebt = Math.max(0, input.carriedDebtTokens - input.cacheDebtRepaymentTokens);
	const combinedBreakeven =
		savingTokens > 0 ? (unpaidDebt + input.writeTokens * costRatio) / savingTokens : null;

	const first = input.priorCompactionCount === 0;
	const windowTokens = positiveFinite(input.contextWindowTokens);
	const windowProtection =
		windowTokens !== null && input.contextTokens >= windowTokens - Math.max(0, input.reserveTokens);

	const horizonOpen = horizon !== null && horizon.expectedRemainingRequests > 0;
	const baseEconomic =
		horizonOpen && breakeven !== null && breakeven <= (horizon?.expectedRemainingRequests ?? 0);
	const firstLeniencyOpen =
		first &&
		horizonOpen &&
		breakeven !== null &&
		breakeven <= (horizon?.expectedRemainingRequests ?? 0) * economics.firstCompactionRequestScale;
	const marginOpen =
		!first &&
		horizonOpen &&
		breakeven !== null &&
		breakeven * economics.subsequentCompactionMargin <= (horizon?.expectedRemainingRequests ?? 0);
	const debtGateOpen =
		!first &&
		horizonOpen &&
		combinedBreakeven !== null &&
		combinedBreakeven <= (horizon?.expectedRemainingRequests ?? 0);

	const economic = first ? firstLeniencyOpen : baseEconomic && marginOpen && debtGateOpen;
	const compressible = savingTokens > 0;
	const effectiveHorizonRequests =
		horizon === null
			? null
			: first
				? horizon.expectedRemainingRequests * economics.firstCompactionRequestScale
				: horizon.expectedRemainingRequests;

	return {
		compact: compressible && (windowProtection || economic),
		reason: !compressible
			? "non_positive_saving"
			: windowProtection
				? "window_protection"
				: economic
					? "economic"
					: horizon === null
						? "horizon_unavailable"
						: breakeven === null
							? "cache_ratio_unavailable"
							: !first && baseEconomic && !marginOpen
								? "deferred_subsequent_margin"
								: !first && baseEconomic && !debtGateOpen
									? "deferred_carried_debt"
									: "deferred_economic",
		savingTokens,
		writeTokens: input.writeTokens,
		breakevenRequests: breakeven,
		combinedBreakevenRequests: combinedBreakeven,
		effectiveHorizonRequests,
		horizon,
		incrementalCacheCostRatio: costRatio,
		carriedDebtTokens: unpaidDebt,
		priorCompactionCount: input.priorCompactionCount,
	};
}

/**
 * What a compaction that just happened owes: the rewrite cost, repaid a
 * `savingTokens` slice at a time by the requests that read the smaller cache.
 * Feed both numbers back in as `carriedDebtTokens` / `cacheDebtRepaymentTokens`
 * on the following requests so the next decision sees this one's bill.
 */
export function compactionDebt(decision: CompactionDecision): {
	debtTokens: number;
	repaymentTokens: number;
} {
	return {
		debtTokens: decision.writeTokens * decision.incrementalCacheCostRatio,
		repaymentTokens: Math.max(0, decision.savingTokens),
	};
}
