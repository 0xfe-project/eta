import { describe, expect, it } from "vitest";
import { authorize, MemoryApprovalStore } from "../../src/realm/authorize";

describe("authorize function unit", () => {
  it("should record approval when askHuman returns true", async () => {
    const store = new MemoryApprovalStore();
    const request = {
      layer: "project" as const,
      capability: "testCap",
      args: [],
    };

    const result = await authorize(request, store, async (_req) => {
      return true;
    });

    expect(result).toBeUndefined(); // Approved
    expect(store.isApproved("project", "testCap")).toBe(true);
  });
});
