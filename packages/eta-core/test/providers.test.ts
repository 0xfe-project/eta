import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import {
  askedThinking,
  kernelThinking,
  providerReasoning,
  reasoningOption,
  THINKING_LEVELS,
  thinkingLevelsFor,
} from "../src/kernel/providers";

describe("models seam", () => {
  // The fake's text/tool-call frame sequence is pinned through Runner in stream.test.ts.
  it("an errored message streams as an error event, carrying the settled error", async () => {
    const settled: AssistantMessage = assistantMessage({
      stopReason: "error",
      errorMessage: "boom",
    });
    const fake = fakeModels([settled]);
    const stream = fake.streamSimple(
      {} as unknown as Model<"openai-completions">,
      { messages: [] },
    );
    const types: string[] = [];
    for await (const event of stream) types.push(event.type);
    expect(types).toEqual(["start", "error"]);
    await expect(stream.result()).resolves.toEqual(settled);
  });
});

describe("thinking levels a model accepts", () => {
  const model = (extra: Record<string, unknown>) =>
    ({
      provider: "p",
      id: "m",
      api: "openai-completions",
      reasoning: true,
      ...extra,
    }) as never;

  it("offers everything when nothing is known about the model", () => {
    expect(thinkingLevelsFor(undefined)).toEqual([...THINKING_LEVELS]);
  });

  it("offers only `off` to a model that does not reason", () => {
    expect(thinkingLevelsFor(model({ reasoning: false }))).toEqual(["off"]);
  });

  it("drops the levels the provider marked unsupported, and keeps the unmentioned ones", () => {
    // `null` is the provider saying "this model does not take this level"; a level the map
    // never mentions is left to the provider's own default, which is why it stays offered.
    expect(
      thinkingLevelsFor(
        model({ thinkingLevelMap: { minimal: null, xhigh: null } }),
      ),
    ).toEqual(["off", "low", "medium", "high", "max"]);
    expect(
      thinkingLevelsFor(
        model({ thinkingLevelMap: { minimal: "low", max: "high" } }),
      ),
    ).toEqual(THINKING_LEVELS.filter((level) => level !== "ultra"));
  });

  it("offers `ultra` only to a model whose map names it", () => {
    // No provider map mentions it by default, so "unmentioned" cannot mean "supported" here.
    expect(thinkingLevelsFor(model({}))).not.toContain("ultra");
    expect(
      thinkingLevelsFor(model({ thinkingLevelMap: { max: "max" } })),
    ).not.toContain("ultra");
    expect(
      thinkingLevelsFor(model({ thinkingLevelMap: { ultra: null } })),
    ).not.toContain("ultra");
    expect(
      thinkingLevelsFor(model({ thinkingLevelMap: { ultra: "ultra" } })),
    ).toContain("ultra");
    // Nothing known about the model: every level, passed as it is.
    expect(thinkingLevelsFor(undefined)).toContain("ultra");
  });
});

describe("what a provider request carries", () => {
  it("sends no reasoning at `off`, nor at a level pi-ai has no word for", () => {
    expect(providerReasoning("off")).toBeUndefined();
    expect(providerReasoning("ultra")).toBeUndefined();
    expect(reasoningOption("ultra")).toEqual({});
    expect(reasoningOption("max")).toEqual({ reasoning: "max" });
    expect(providerReasoning("high")).toBe("high");
  });

  it("records what a run asked for and what it sent", () => {
    // Asked and taken.
    expect(
      kernelThinking({ thinkingLevel: "high", thinkingAsked: "high" }),
    ).toEqual({ asked: "high", sent: "high" });
    // Asked for a level the model does not take: the session runs on `off`, the default.
    expect(
      kernelThinking({ thinkingLevel: "off", thinkingAsked: "ultra" }),
    ).toEqual({ asked: "ultra", sent: null });
    // Nothing asked.
    expect(
      kernelThinking({ thinkingLevel: "off", thinkingAsked: null }),
    ).toEqual({ asked: null, sent: null });
    // `off` chosen is `off` sent (the kernel's spelling of it).
    expect(
      kernelThinking({ thinkingLevel: "off", thinkingAsked: "off" }),
    ).toEqual({ asked: "off", sent: "off" });
    // A session from before the ask was kept: its level is the ask, `off` is no choice.
    expect(kernelThinking({ thinkingLevel: "medium" })).toEqual({
      asked: "medium",
      sent: "medium",
    });
    expect(askedThinking({ thinkingLevel: "off" })).toBeNull();
  });
});
