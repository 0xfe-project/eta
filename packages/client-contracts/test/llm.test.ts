import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LLM_CODES } from "../src/index";

// The Go side (packages/llm-gateway/gateway/codes.go) keeps its list in codes.json, and its own
// test keeps the two equal; this keeps the TypeScript union equal to the file.
describe("llm problem codes", () => {
  it("are the gateway's codes, in the same order", () => {
    const gateway = JSON.parse(
      readFileSync(
        new URL("../../llm-gateway/codes.json", import.meta.url),
        "utf8",
      ),
    ) as string[];
    expect([...LLM_CODES]).toEqual(gateway);
  });

  it("are lowercase snake_case and unique", () => {
    expect(new Set(LLM_CODES).size).toBe(LLM_CODES.length);
    for (const code of LLM_CODES) expect(code).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });
});
