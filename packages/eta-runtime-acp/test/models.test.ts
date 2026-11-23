/**
 * The reasoning level an ACP agent is asked for (`models.ts`): a level it offers goes as it is,
 * `ultra` included and never turned into `max`; one it does not offer goes as nothing.
 */
import { thinkingLevelsFor } from "@eta/core";
import { describe, expect, it } from "vitest";
import { acpModels, effortFor } from "../src/models";

describe("effortFor on an ACP agent", () => {
  it("passes `ultra` to an agent that offers it", () => {
    expect(effortFor("ultra", ["low", "high", "max", "ultra"])).toBe("ultra");
  });

  it("passes nothing for `ultra` to an agent that does not offer it, never `max`", () => {
    expect(effortFor("ultra", ["low", "high", "max"])).toBeUndefined();
  });

  it("asks for the agent's off switch at `off`, and nothing where it has none", () => {
    expect(effortFor("off", ["none", "low"])).toBe("none");
    expect(effortFor("off", ["off", "high"])).toBe("off");
    expect(effortFor("off", ["low", "high"])).toBeUndefined();
  });

  it("offers `ultra` as a thinking level only where the agent lists it", () => {
    const levels = (efforts: string[]) =>
      thinkingLevelsFor(
        acpModels("acp.probe", () => [
          { id: "m", name: "M", default: true, efforts },
        ]).getModel("acp.probe", "m"),
      );
    expect(levels(["low", "max", "ultra"])).toContain("ultra");
    expect(levels(["low", "max"])).not.toContain("ultra");
  });
});
