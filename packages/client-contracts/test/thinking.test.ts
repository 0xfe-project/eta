import type { ThinkingCatalog } from "../src";
import { describe, expect, it } from "vitest";
import {
  agentThinking,
  FALLBACK_LEVELS,
  keptLevel,
  levelSupport,
} from "../src";

/** A host with the endpoint models of #799 and a Codex that lists its levels. */
const catalog: ThinkingCatalog = {
  providers: [
    {
      id: "proxy",
      models: [
        {
          id: "deepseek-v4.1-flash",
          reasoning: true,
          reasoningEfforts: ["high", "max"],
        },
        {
          id: "hy4-flash-free",
          reasoning: true,
          reasoningEfforts: ["high"],
          thinkingMode: "both",
        },
        { id: "plain", reasoning: false },
        { id: "silent" },
        { id: "thinks", reasoning: true },
        {
          id: "overridden",
          reasoning: true,
          reasoningEfforts: ["low"],
          overrides: { reasoningEfforts: ["low", "medium"] },
        },
      ],
    },
  ],
  llm: [{ id: "gpt-6", reasoning: true, reasoningEfforts: ["low", "xhigh"] }],
  runtimes: [
    {
      id: "codex",
      status: "available",
      models: [
        {
          id: "gpt-6-astra",
          name: "Astra",
          default: true,
          efforts: ["none", "low", "high", "ultra"],
        },
        { id: "plain", name: "Plain", default: false, efforts: [] },
        {
          id: "unsure",
          name: "Unsure",
          default: false,
          efforts: [],
          effortsUnknown: true,
        },
      ],
    },
  ],
};

const levels = (
  runtime: Parameters<typeof agentThinking>[0],
  model: string | null,
) => agentThinking(runtime, model, catalog).levels;

describe("the levels an agent can be set to", () => {
  it("offers only what a model declares", () => {
    expect(levels("eta", "proxy:deepseek-v4.1-flash")).toEqual(["high", "max"]);
  });

  it("offers off to a model that declares none", () => {
    expect(levels("eta", "proxy:hy4-flash-free")).toEqual(["off", "high"]);
  });

  it("offers only off to a model that does not reason", () => {
    expect(agentThinking("eta", "proxy:plain", catalog)).toEqual({
      basis: "declared",
      levels: ["off"],
    });
  });

  it("offers only off to an eta model that says nothing, and says why", () => {
    expect(agentThinking("eta", "proxy:silent", catalog)).toEqual({
      basis: "undeclared",
      levels: ["off"],
    });
  });

  it("falls back to five levels when a model's are not known", () => {
    expect(agentThinking("eta", "proxy:thinks", catalog)).toEqual({
      basis: "unknown",
      levels: FALLBACK_LEVELS,
    });
    expect(agentThinking("eta", "proxy:not-listed", catalog).basis).toBe(
      "unknown",
    );
    expect(agentThinking("codex", "codex:gpt-6-astra", {}).levels).toEqual(
      FALLBACK_LEVELS,
    );
    expect(levels("codex", "codex:unsure")).toEqual(FALLBACK_LEVELS);
  });

  it("reads an override over the provider's declaration", () => {
    expect(levels("eta", "proxy:overridden")).toEqual(["low", "medium"]);
  });

  it("reads the gateway's models", () => {
    expect(levels("eta", "llm:gpt-6")).toEqual(["low", "xhigh"]);
  });

  it("offers ultra only where a runtime lists it, and off where it lists none", () => {
    expect(levels("codex", "codex:gpt-6-astra")).toEqual([
      "off",
      "low",
      "high",
      "ultra",
    ]);
    expect(levels("codex", null)).toEqual(["off", "low", "high", "ultra"]);
    expect(levels("eta", "proxy:deepseek-v4.1-flash")).not.toContain("ultra");
  });

  it("offers nothing but the default where a runtime has no effort setting", () => {
    expect(agentThinking("codex", "codex:plain", catalog)).toEqual({
      basis: "none",
      levels: [],
    });
  });
});

describe("a level against a model", () => {
  const flash = agentThinking("eta", "proxy:deepseek-v4.1-flash", catalog);
  const unknown = agentThinking("eta", "proxy:thinks", catalog);

  it("is supported, unsupported, or not known", () => {
    expect(levelSupport(flash, "max")).toBe("supported");
    expect(levelSupport(flash, "ultra")).toBe("unsupported");
    expect(levelSupport(unknown, "xhigh")).toBe("unknown");
  });

  it("is kept across a model change only where the new model may take it", () => {
    expect(keptLevel(flash, "high")).toBe("high");
    expect(keptLevel(flash, "minimal")).toBeNull();
    expect(keptLevel(unknown, "xhigh")).toBe("xhigh");
    expect(keptLevel(flash, null)).toBeNull();
  });
});
