/**
 * Drift detection: doom loops (repeated identical tool calls), content tail
 * repetition, and single-message loops (near-identical assistant output).
 * Port of the Rust core's loop_detect.rs (thresholds and semantics preserved).
 * Pure functions, no I/O.
 */

const JUARO_WINKLER_THRESHOLD = 0.7;
const SORENSEN_DICE_THRESHOLD = 0.7;

/** Levenshtein edit distance (standard DP, no deps). */
export function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	const la = a.length;
	const lb = b.length;
	if (la === 0) return lb;
	if (lb === 0) return la;
	let prev = new Array<number>(lb + 1);
	let curr = new Array<number>(lb + 1);
	for (let j = 0; j <= lb; j++) prev[j] = j;
	for (let i = 1; i <= la; i++) {
		curr[0] = i;
		for (let j = 1; j <= lb; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[lb];
}

function jaro(a: string, b: string): number {
	if (a === b) return 1;
	if (a.length === 0 || b.length === 0) return 0;
	const matchWindow = Math.max(Math.floor(Math.max(a.length, b.length) / 2) - 1, 0);
	const aMatches = new Array<boolean>(a.length).fill(false);
	const bMatches = new Array<boolean>(b.length).fill(false);
	let matches = 0;
	for (let i = 0; i < a.length; i++) {
		const start = Math.max(0, i - matchWindow);
		const end = Math.min(i + matchWindow + 1, b.length);
		for (let j = start; j < end; j++) {
			if (bMatches[j] || a[i] !== b[j]) continue;
			aMatches[i] = true;
			bMatches[j] = true;
			matches++;
			break;
		}
	}
	if (matches === 0) return 0;
	let transpositions = 0;
	let k = 0;
	for (let i = 0; i < a.length; i++) {
		if (!aMatches[i]) continue;
		while (!bMatches[k]) k++;
		if (a[i] !== b[k]) transpositions++;
		k++;
	}
	const t = transpositions / 2;
	return (matches / a.length + matches / b.length + (matches - t) / matches) / 3;
}

/** Jaro-Winkler with the standard 0.1 scaling and 4-char prefix cap. */
export function jaroWinkler(a: string, b: string): number {
	const j = jaro(a, b);
	if (j < 0.7) return j;
	let prefix = 0;
	for (let i = 0; i < Math.min(4, Math.min(a.length, b.length)); i++) {
		if (a[i] !== b[i]) break;
		prefix++;
	}
	return j + prefix * 0.1 * (1 - j);
}

/** Sørensen-Dice over character bigrams; tolerant of word reordering. */
export function sorensenDice(a: string, b: string): number {
	if (a === b) return 1;
	if (a.length < 2 || b.length < 2) return 0;
	const bigrams = (s: string): Map<string, number> => {
		const m = new Map<string, number>();
		for (let i = 0; i < s.length - 1; i++) {
			const bg = s.slice(i, i + 2);
			m.set(bg, (m.get(bg) ?? 0) + 1);
		}
		return m;
	};
	const ma = bigrams(a);
	const mb = bigrams(b);
	let overlap = 0;
	for (const [bg, ca] of ma) overlap += Math.min(ca, mb.get(bg) ?? 0);
	return (2 * overlap) / (a.length - 1 + b.length - 1);
}

/** True when `a` and `b` are similar enough to be the same message. */
export function isSimilar(a: string, b: string): boolean {
	if (a === b) return true;
	const editBudget = Math.max(1, Math.floor(Math.max(a.length, b.length) / 4));
	return (
		levenshtein(a, b) <= editBudget ||
		jaroWinkler(a, b) > JUARO_WINKLER_THRESHOLD ||
		sorensenDice(a, b) > SORENSEN_DICE_THRESHOLD
	);
}

/** How many identical tool calls before it counts as a doom loop. */
export const DOOM_LOOP_THRESHOLD = 3;

/** Detects repeated identical tool calls (name + arguments fingerprint). */
export class DoomLoopDetector {
	private callCounts = new Map<string, number>();

	/** Record one tool call; true once it repeated enough to look stuck. */
	observe(name: string, args: unknown): boolean {
		const fingerprint = `${name}:${JSON.stringify(args ?? null)}`;
		const count = (this.callCounts.get(fingerprint) ?? 0) + 1;
		this.callCounts.set(fingerprint, count);
		return count >= DOOM_LOOP_THRESHOLD;
	}

	reset(): void {
		this.callCounts.clear();
	}
}

/**
 * Detects tail repetition inside one content blob: the trailing line repeated
 * `minRepeats`+ times. Returns the repeated tail, or undefined.
 */
export function tailRepetition(content: string, minRepeats: number): string | undefined {
	if (content.length < 64 || minRepeats < 2) return undefined;
	const tail = content.trimEnd();
	const lines = tail.split("\n");
	const unit = (lines[lines.length - 1] ?? "").trim();
	if (unit.length < 16) return undefined;
	let repeats = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].trim() === unit) repeats++;
		else break;
	}
	return repeats >= minRepeats ? unit : undefined;
}

/** Single-message loop: the assistant keeps producing (near-)identical text. */
export class LoopDetector {
	private lastContent: string | undefined;
	private repeatCount = 0;

	/** Feed one step's assistant text; true when it looks like a loop. */
	observe(content: string): boolean {
		if (this.lastContent !== undefined && isSimilar(this.lastContent, content)) {
			this.repeatCount += 1;
			return this.repeatCount >= 2;
		}
		this.lastContent = content;
		this.repeatCount = 0;
		return false;
	}

	reset(): void {
		this.lastContent = undefined;
		this.repeatCount = 0;
	}
}
