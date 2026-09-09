import { describe, expect, it } from "vitest";
import * as prompts from "../../src/prompts/index.ts";

describe("prompt assets are locked", () => {
	it("matches snapshots (verbatim ports; change only with a plan entry)", () => {
		expect({
			DEFAULT_SYSTEM_PROMPT: prompts.DEFAULT_SYSTEM_PROMPT,
			goalEvaluator: prompts.goalEvaluatorPrompt("OBJ"),
			goalGuidelines: prompts.goalPursuitGuidelines("OBJ"),
			MEMORY_EXTRACT_PROMPT: prompts.MEMORY_EXTRACT_PROMPT,
			MEMORY_EXTRACT_SYSTEM_PROMPT: prompts.MEMORY_EXTRACT_SYSTEM_PROMPT,
			TODO_UPDATE_SUCCESS: prompts.TODO_UPDATE_SUCCESS,
			TODO_REVIEW_PROMPT: prompts.TODO_REVIEW_PROMPT,
			SUMMARIZE_SYSTEM_PROMPT: prompts.SUMMARIZE_SYSTEM_PROMPT,
			SUMMARIZE_REQUEST: prompts.SUMMARIZE_REQUEST,
			SUMMARIZE_SHORTER_RETRY: prompts.SUMMARIZE_SHORTER_RETRY,
			previousSummary: prompts.previousSummary("S"),
			UNTRUSTED_SUMMARY_NOTE: prompts.UNTRUSTED_SUMMARY_NOTE,
			resume: [prompts.RESUME, prompts.RESUME_TRUNCATED, prompts.RESUME_EMPTY, prompts.RESUME_LOOP],
		}).toMatchSnapshot();
	});
});
