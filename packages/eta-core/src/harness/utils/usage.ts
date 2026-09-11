import type { Usage } from "@earendil-works/pi-ai";

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Undo an `addUsage`. Clamped at zero so a totals aggregate never goes negative. */
export function subtractUsage(left: Usage, right: Usage): Usage {
	const clamp = (value: number): number => (value > 0 ? value : 0);
	return {
		input: clamp(left.input - right.input),
		output: clamp(left.output - right.output),
		cacheRead: clamp(left.cacheRead - right.cacheRead),
		cacheWrite: clamp(left.cacheWrite - right.cacheWrite),
		...(left.cacheWrite1h === undefined && right.cacheWrite1h === undefined
			? {}
			: { cacheWrite1h: clamp((left.cacheWrite1h ?? 0) - (right.cacheWrite1h ?? 0)) }),
		...(left.reasoning === undefined && right.reasoning === undefined
			? {}
			: { reasoning: clamp((left.reasoning ?? 0) - (right.reasoning ?? 0)) }),
		totalTokens: clamp(left.totalTokens - right.totalTokens),
		cost: {
			input: clamp(left.cost.input - right.cost.input),
			output: clamp(left.cost.output - right.cost.output),
			cacheRead: clamp(left.cost.cacheRead - right.cost.cacheRead),
			cacheWrite: clamp(left.cost.cacheWrite - right.cost.cacheWrite),
			total: clamp(left.cost.total - right.cost.total),
		},
	};
}

export function addUsage(left: Usage, right: Usage): Usage {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		...(left.cacheWrite1h === undefined && right.cacheWrite1h === undefined
			? {}
			: { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) }),
		...(left.reasoning === undefined && right.reasoning === undefined
			? {}
			: { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }),
		totalTokens: left.totalTokens + right.totalTokens,
		cost: {
			input: left.cost.input + right.cost.input,
			output: left.cost.output + right.cost.output,
			cacheRead: left.cost.cacheRead + right.cost.cacheRead,
			cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
			total: left.cost.total + right.cost.total,
		},
	};
}
