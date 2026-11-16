import { describe, expect, it } from "vitest";
import {
  isCustomKind,
  keyMissing,
  providerLabel,
  signsIn,
} from "../src/providers";

describe("what a provider is called", () => {
  it("prefers its own name, then its kind's, then its id", () => {
    expect(providerLabel({ id: "a", kind: "deepseek", name: "公司" })).toBe(
      "公司",
    );
    expect(providerLabel({ id: "a", kind: "deepseek" })).toBe("DeepSeek");
    expect(providerLabel({ id: "a", kind: "commandcode" })).toBe(
      "Command Code",
    );
    expect(providerLabel({ id: "mine", kind: "openai-compatible" })).toBe(
      "mine",
    );
  });
});

describe("kinds", () => {
  it("knows which kinds bring their own endpoint", () => {
    expect(isCustomKind(undefined)).toBe(true);
    expect(isCustomKind("openai-compatible")).toBe(true);
    expect(isCustomKind("openai-responses")).toBe(true);
    expect(isCustomKind("deepseek")).toBe(false);
  });

  it("needs a key for the kinds that cannot run without one, and none for Codex or custom endpoints", () => {
    for (const kind of [
      "eta",
      "deepseek",
      "kimi-coding",
      "zai",
      "zai-coding-cn",
      "opencode",
      "opencode-go",
      "commandcode",
    ] as const) {
      expect(keyMissing({ kind, hasApiKey: false }), kind).toBe(true);
      expect(keyMissing({ kind, hasApiKey: true }), kind).toBe(false);
    }
    for (const kind of [
      "openai-codex",
      "openai-compatible",
      "openai-responses",
    ] as const)
      expect(keyMissing({ kind, hasApiKey: false }), kind).toBe(false);
    expect(signsIn({ kind: "openai-codex" })).toBe(true);
    expect(signsIn({ kind: "deepseek" })).toBe(false);
  });

  it("reads nothing off the object prototype for a kind it does not know", () => {
    expect(providerLabel({ id: "x", kind: "constructor" as never })).toBe("x");
    expect(isCustomKind("toString" as never)).toBe(false);
  });
});
