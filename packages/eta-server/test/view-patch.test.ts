import { describe, expect, test } from "bun:test";
import type { SessionView } from "@eta/core";
import { HEAVY_VIEW_FIELDS, viewFingerprint, viewPatch } from "../src/protocol.ts";

function view(patch: Record<string, unknown> = {}): SessionView {
	return {
		messages: [{ entryId: "e1", seq: 1, at: 0, message: { role: "user", content: "hi" } }],
		systems: [],
		thinking: [],
		compactionEpoch: 0,
		branch: { tipId: "e1" },
		usage: { input: 1, output: 1 },
		...patch,
	} as unknown as SessionView;
}

describe("view patch frames", () => {
	test("a patch carries everything except the transcript", () => {
		const keys = Object.keys(viewPatch(view({ model: "x" })));
		for (const field of HEAVY_VIEW_FIELDS) expect(keys).not.toContain(field);
		expect(keys).toContain("usage");
		expect(keys).toContain("branch");
	});

	test("streaming a token does not move the fingerprint", () => {
		const before = viewFingerprint(view());
		const after = viewFingerprint(
			view({
				usage: { input: 1, output: 2 },
				cacheRate: 0.5,
				tokensPerSec: 33,
				streaming: { role: "assistant", content: [{ type: "text", text: "hel" }] },
				contextShare: { userChars: 2, assistantChars: 3, toolChars: 0, toolDefChars: 0 },
			}),
		);
		expect(after).toBe(before);
	});

	test("an appended message, a new branch tip, or a compaction does", () => {
		const base = viewFingerprint(view());
		const grown = viewFingerprint(
			view({
				messages: [
					{ entryId: "e1", seq: 1, at: 0, message: { role: "user", content: "hi" } },
					{ entryId: "e2", seq: 2, at: 1, message: { role: "assistant", content: "yo" } },
				],
			}),
		);
		const rewound = viewFingerprint(view({ branch: { tipId: "e0" } }));
		const compacted = viewFingerprint(view({ compactionEpoch: 1 }));
		expect(grown).not.toBe(base);
		expect(rewound).not.toBe(base);
		expect(compacted).not.toBe(base);
	});
});
