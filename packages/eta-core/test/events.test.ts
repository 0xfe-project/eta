import { Context } from "cordis";
import { describe, expect, it } from "vitest";
import { kernelEmit, kernelOn } from "../src/types/events";

describe("the event bus", () => {
  it("kernelEmit/kernelOn round-trip over a real cordis context", () => {
    const ctx = new Context();
    const seen: { name: string; payload: unknown }[] = [];
    const off = kernelOn(ctx)("tool:end", (p) => {
      seen.push({ name: "tool:end", payload: p });
    });
    const emit = kernelEmit(ctx);
    emit("tool:end", {
      runId: "r1",
      turnId: "t1",
      toolCallId: "c1",
      toolName: "bash",
      result: { ok: true },
      isError: false,
      terminate: false,
      durationMs: 5,
    });
    emit("task:created", {
      action: "created",
      task: { id: "t1", content: "c", status: "pending" },
    });
    off();
    emit("tool:end", {
      runId: "r1",
      turnId: "t2",
      toolCallId: "c2",
      toolName: "bash",
      result: { ok: false },
      isError: true,
      terminate: false,
      durationMs: 1,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toMatchObject({
      toolName: "bash",
      result: { ok: true },
    });
    void ctx.fiber.dispose();
  });
});
