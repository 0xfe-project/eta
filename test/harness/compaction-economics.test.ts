import { describe, expect, it } from "vitest";
import {
	DEFAULT_COMPACTION_ECONOMICS,
	compactionDebt,
	decideCompaction,
	estimateRequestHorizon,
	type CompactionPricingInput,
} from "../../src/harness/compaction/economics.ts";

/**
 * One scene, tuned so the numbers stay readable: a 100k context paying 11.5x on a
 * rewrite of itself, giving up 55k tokens to a summary, with five requests
 * observed between finished steps.
 */
const pricing = (over: Partial<CompactionPricingInput> = {}): CompactionPricingInput => ({
	writeTokens: 100_000,
	archiveTokens: 60_000,
	memoTokens: 5_000,
	contextTokens: 100_000,
	contextWindowTokens: 200_000,
	reserveTokens: 16_384,
	completedBoundaryRequestCounts: [4, 6, 5],
	remainingBoundaries: 3,
	averageContextTokenIncrement: 2_000,
	priorCompactionCount: 0,
	carriedDebtTokens: 0,
	cacheDebtRepaymentTokens: 0,
	economics: DEFAULT_COMPACTION_ECONOMICS,
	...over,
});

// 100_000 * 11.5 / 55_000
const BREAKEVEN = 20.909_090_909_090_908;

describe("request horizon", () => {
	it("extrapolates from observed boundaries", () => {
		const horizon = estimateRequestHorizon({
			completedBoundaryRequestCounts: [4, 6, 5],
			remainingBoundaries: 3,
			contextTokens: 100_000,
			contextWindowTokens: null,
			averageContextTokenIncrement: null,
		});
		expect(horizon.requestsPerBoundaryMean).toBe(5);
		expect(horizon.expectedRemainingRequests).toBe(16);
	});

	it("caps the guess at whatever still fits in the window", () => {
		const horizon = estimateRequestHorizon({
			completedBoundaryRequestCounts: [10, 10],
			remainingBoundaries: 5,
			contextTokens: 100_000,
			contextWindowTokens: 200_000,
			averageContextTokenIncrement: 20_000,
		});
		expect(horizon.windowRequestUpperBound).toBe(5);
		expect(horizon.expectedRemainingRequests).toBe(5);
	});

	it("has no window bound to offer without a growth rate", () => {
		const horizon = estimateRequestHorizon({
			completedBoundaryRequestCounts: [],
			remainingBoundaries: 2,
			contextTokens: 100_000,
			contextWindowTokens: 200_000,
			averageContextTokenIncrement: null,
		});
		expect(horizon.windowRequestUpperBound).toBeNull();
		expect(horizon.expectedRemainingRequests).toBe(1);
	});
});

describe("compaction decisions", () => {
	it("prices one request to break even before it cuts", () => {
		const decision = decideCompaction(pricing());
		expect(decision.breakevenRequests ?? 0).toBeCloseTo(BREAKEVEN, 6);
		expect(decision.compact).toBe(true);
		expect(decision.reason).toBe("economic");
	});

	it("cuts nothing when it has no idea how much run is left", () => {
		const decision = decideCompaction(pricing({ completedBoundaryRequestCounts: null }));
		expect(decision.compact).toBe(false);
		expect(decision.reason).toBe("horizon_unavailable");
	});

	it("cuts on window pressure even when the price says no", () => {
		const decision = decideCompaction(
			pricing({ contextTokens: 190_000, completedBoundaryRequestCounts: null, remainingBoundaries: 0 }),
		);
		expect(decision.compact).toBe(true);
		expect(decision.reason).toBe("window_protection");
	});

	it("will not pay a rewrite for a summary that saves nothing", () => {
		const decision = decideCompaction(pricing({ memoTokens: 60_000 }));
		expect(decision.compact).toBe(false);
		expect(decision.reason).toBe("non_positive_saving");
	});

	it("gives the first cut the benefit of a doubtful estimate", () => {
		// Horizon 11, lenient horizon 22, breakeven 20.9: only the first-cut scale clears it.
		const first = decideCompaction(pricing({ priorCompactionCount: 0, remainingBoundaries: 2 }));
		const later = decideCompaction(pricing({ priorCompactionCount: 1, remainingBoundaries: 2 }));
		expect(first.horizon?.expectedRemainingRequests).toBe(11);
		expect(first.compact).toBe(true);
		expect(later.compact).toBe(false);
		expect(later.reason).toBe("deferred_economic");
	});

	it("asks a second cut for real margin, not just a wash", () => {
		// Horizon 26 pays breakeven 20.9 but not breakeven x 1.5 = 31.4.
		const decision = decideCompaction(pricing({ priorCompactionCount: 1, remainingBoundaries: 5 }));
		expect(decision.horizon?.expectedRemainingRequests).toBe(26);
		expect(decision.compact).toBe(false);
		expect(decision.reason).toBe("deferred_subsequent_margin");
	});

	it("charges the next cut for the last one's unpaid rewrite", () => {
		const decision = decideCompaction(
			pricing({ priorCompactionCount: 1, remainingBoundaries: 7, carriedDebtTokens: 900_000 }),
		);
		expect(decision.horizon?.expectedRemainingRequests).toBe(36);
		expect(decision.combinedBreakevenRequests ?? 0).toBeGreaterThan(36);
		expect(decision.compact).toBe(false);
		expect(decision.reason).toBe("deferred_carried_debt");
	});

	it("credits the savings already banked against that debt", () => {
		const decision = decideCompaction(
			pricing({
				priorCompactionCount: 1,
				remainingBoundaries: 7,
				carriedDebtTokens: 900_000,
				cacheDebtRepaymentTokens: 200_000,
			}),
		);
		expect(decision.compact).toBe(true);
		expect(decision.reason).toBe("economic");
	});

	it("defers without a story to tell when the horizon is simply too short", () => {
		const decision = decideCompaction(pricing({ priorCompactionCount: 1, remainingBoundaries: 1 }));
		expect(decision.compact).toBe(false);
		expect(decision.reason).toBe("deferred_economic");
	});
});

describe("debt a compaction leaves behind", () => {
	it("is the rewrite price, repaid by the savings of each later request", () => {
		const decision = decideCompaction(pricing());
		expect(compactionDebt(decision)).toEqual({ debtTokens: 1_150_000, repaymentTokens: 55_000 });
	});

	it("charges nothing when the provider prices cache writes at reads", () => {
		const decision = decideCompaction(
			pricing({ economics: { ...DEFAULT_COMPACTION_ECONOMICS, cacheWriteReadRatio: 1 } }),
		);
		expect(decision.incrementalCacheCostRatio).toBe(0);
		expect(compactionDebt(decision).debtTokens).toBe(0);
	});
});
