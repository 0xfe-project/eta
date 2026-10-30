import { describe, expect, it } from "vitest";
import { LLM_CODES } from "../src/index";

// What each code means and which params it carries: apps/eta/src/llm/problems.ts.
describe("llm problem codes", () => {
  it("are lowercase snake_case and unique", () => {
    expect(new Set(LLM_CODES).size).toBe(LLM_CODES.length);
    for (const code of LLM_CODES) expect(code).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });
});
