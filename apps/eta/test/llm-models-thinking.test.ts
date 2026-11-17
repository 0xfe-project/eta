/**
 * eta's own models never take `ultra` (#624): it is an external runtime's level, the gateway's
 * effort words are read through a list that does not have it, and pi-ai has no word for it.
 */
import { thinkingLevelsFor } from "@eta/core";
import { describe, expect, it } from "vitest";
import { GatewayModels } from "../src/llm/models";

describe("the gateway's models", () => {
  it("do not offer `ultra`, even when the gateway names it", async () => {
    const models = new GatewayModels();
    models.attach({ baseUrl: "http://127.0.0.1:1/v1", key: "k" });
    await models.update([
      {
        id: "big",
        connector: "codex",
        name: "Big",
        status: "ok",
        available: true,
        reasoningLevels: ["low", "high", "xhigh", "max", "ultra"],
        image: false,
      } as never,
    ]);
    const layer = models.overlay({
      getModel: () => undefined,
    } as never);
    const levels = thinkingLevelsFor(layer.getModel("llm", "big"));
    expect(levels).toContain("max");
    expect(levels).not.toContain("ultra");
  });
});
