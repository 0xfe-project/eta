/**
 * The effort a runtime is asked for at a thinking level (`models.ts`). What these pin: a level the
 * model lists goes as it is, `ultra` included and never turned into `max`; one it does not list
 * goes as nothing (the runtime's default); and one asked of a model whose levels are unknown goes
 * as it is.
 */
import type { RuntimeCatalog } from "../src/catalog";
import { thinkingLevelsFor } from "@eta/core";
import { describe, expect, it } from "vitest";
import { effortFor, runtimeModels } from "../src/models";

const ULTRA = ["low", "medium", "high", "xhigh", "max", "ultra"];

describe("effortFor", () => {
  it("passes `ultra` to a model that lists it", () => {
    expect(effortFor("ultra", ULTRA)).toBe("ultra");
    expect(effortFor("xhigh", ULTRA)).toBe("xhigh");
    expect(effortFor("max", ULTRA)).toBe("max");
  });

  it("passes nothing for `ultra` to a model that does not list it, never `max`", () => {
    expect(effortFor("ultra", ["low", "medium", "high", "xhigh", "max"])).toBe(
      undefined,
    );
    expect(effortFor("ultra", ["low", "high"])).toBeUndefined();
  });

  it("passes the level as it is while the model's levels are unknown", () => {
    expect(effortFor("ultra", undefined)).toBe("ultra");
  });

  it("asks nothing at `off`, unless the model lists an off switch", () => {
    expect(effortFor("off", ULTRA)).toBeUndefined();
    expect(effortFor("off", ["none", "low", "high"])).toBe("none");
  });
});

describe("a model whose levels the runtime could not say", () => {
  it("passes the level as it is", () => {
    const catalog = {
      peek: () => ({
        id: "codex",
        label: "Codex",
        status: "available",
        models: [
          {
            id: "gpt-astra",
            name: "Astra",
            default: true,
            efforts: [],
            effortsUnknown: true,
          },
        ],
      }),
    } as unknown as RuntimeCatalog;
    const model = runtimeModels("codex", catalog).getModel(
      "codex",
      "gpt-astra",
    );
    // Not held to `off` as a model without an effort setting is.
    expect(thinkingLevelsFor(model)).toContain("high");
  });
});

describe("a runtime model's thinking levels", () => {
  const catalog = (efforts: string[]) =>
    ({
      peek: () => ({
        id: "codex",
        label: "Codex",
        status: "available",
        models: [{ id: "gpt-astra", name: "Astra", default: true, efforts }],
      }),
    }) as unknown as RuntimeCatalog;

  it("offers `ultra` where the runtime lists it, and not where it does not", () => {
    const listed = runtimeModels("codex", catalog(ULTRA)).getModel(
      "codex",
      "gpt-astra",
    );
    // `off` asks nothing and `minimal` asks `low`: both are always there.
    expect(thinkingLevelsFor(listed)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    const short = runtimeModels("codex", catalog(["low", "high"])).getModel(
      "codex",
      "gpt-astra",
    );
    expect(thinkingLevelsFor(short)).not.toContain("ultra");
  });
});
