import { describe, expect, it } from "@rstest/core";
import {
  declaredLevels,
  effortDiffers,
  FALLBACK_LEVELS,
  levelsFor,
  levelSupport,
} from "./thinking";

describe("levelsFor", () => {
  it("offers an eta model's declared levels, lowest first", () => {
    expect(levelsFor({ efforts: ["high", "low", "max"] })).toEqual([
      "low",
      "high",
      "max",
    ]);
  });

  it("adds `off` to a model that can also be told not to think", () => {
    expect(
      levelsFor({ efforts: ["low", "medium"], thinkingMode: "both" }),
    ).toEqual(["off", "low", "medium"]);
    expect(
      levelsFor({ efforts: ["low", "medium"], thinkingMode: "only" }),
    ).toEqual(["low", "medium"]);
  });

  it("offers an external model's xhigh, max and ultra when it declares them", () => {
    expect(
      levelsFor({
        efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      }),
    ).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    // A runtime's own word that is not a thinking level is not one an agent can be set to.
    expect(levelsFor({ efforts: ["none", "low", "ultra"] })).toEqual([
      "low",
      "ultra",
    ]);
  });

  it("falls back to the five levels when nothing is known", () => {
    const five = ["off", "minimal", "low", "medium", "high"];
    expect(FALLBACK_LEVELS).toEqual(five);
    expect(levelsFor(undefined)).toEqual(five);
    expect(levelsFor({ efforts: [] })).toEqual(five);
    expect(levelsFor({ efforts: ["none"] })).toEqual(five);
    expect(declaredLevels(undefined)).toBeUndefined();
  });
});

describe("whether a model takes a level", () => {
  it("is supported, unsupported, or unknown", () => {
    expect(levelSupport(["low", "ultra"], "ultra")).toBe("supported");
    expect(levelSupport(["low", "high"], "ultra")).toBe("unsupported");
    expect(levelSupport(undefined, "ultra")).toBe("unknown");
  });
});

describe("a run's thinking record", () => {
  it("differs only when what was sent is not what was asked", () => {
    expect(effortDiffers({ asked: "ultra", sent: "ultra" })).toBe(false);
    expect(effortDiffers({ asked: null, sent: null })).toBe(false);
    expect(effortDiffers({ asked: "ultra", sent: null })).toBe(true);
    expect(effortDiffers({ asked: "minimal", sent: "low" })).toBe(true);
  });
});
