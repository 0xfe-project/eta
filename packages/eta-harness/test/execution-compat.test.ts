import { describe, expect, it } from "vitest";
import { ExecutionError, FileError, getOrThrow } from "@eta/execution";
import { OutputBuffer, truncateTail } from "@eta/execution/output";
import * as harness from "@eta/harness";
import * as legacyEnv from "@eta/harness/env";

describe("execution compatibility exports", () => {
	it("preserves error identity and output helpers for existing consumers", () => {
		expect(harness.FileError).toBe(FileError);
		expect(legacyEnv.FileError).toBe(FileError);
		expect(harness.ExecutionError).toBe(ExecutionError);
		expect(legacyEnv.getOrThrow).toBe(getOrThrow);
		expect(harness.OutputBuffer).toBe(OutputBuffer);
		expect(harness.truncateTail).toBe(truncateTail);
	});
});
