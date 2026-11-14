import type { AgentMessage } from "@eta/core";
import { describe, expect, it } from "vitest";
import { ActivityRecorder } from "../src/activity";

const asked = (id: string, name: string, args: unknown): AgentMessage =>
  ({
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
  }) as never;
const answered = (
  id: string,
  text: string,
  extra: Record<string, unknown> = {},
): AgentMessage =>
  ({
    role: "toolResult",
    toolCallId: id,
    content: [{ type: "text", text }],
    isError: false,
    ...extra,
  }) as never;

describe("activityRecorder", () => {
  it("pairs a call with its result and keeps the details", () => {
    const recorder = new ActivityRecorder();
    recorder.see(asked("c1", "publish_artifact", { title: "t" }));
    recorder.see(
      answered("c1", "published", { details: { artifactId: "a", version: 1 } }),
    );
    expect(recorder.list()).toEqual([
      {
        id: "c1",
        name: "publish_artifact",
        input: { title: "t" },
        output: "published",
        status: "completed",
        details: { artifactId: "a", version: 1 },
      },
    ]);
  });

  it("marks an error as failed, an unanswered call as failed, and drops big details", () => {
    const recorder = new ActivityRecorder();
    recorder.see(asked("c1", "bash", { command: "false" }));
    recorder.see(answered("c1", "boom", { isError: true }));
    recorder.see(asked("c2", "bash", { command: "sleep 99" }));
    recorder.see(asked("c3", "read", { path: "a" }));
    recorder.see(
      answered("c3", "ok", { details: { blob: "y".repeat(80_000) } }),
    );
    const [one, two, three] = recorder.list();
    expect(one).toMatchObject({ status: "failed", output: "boom" });
    expect(two).toMatchObject({ status: "failed" });
    expect(two).not.toHaveProperty("output");
    expect(three).toMatchObject({ status: "completed" });
    expect(three).not.toHaveProperty("details");
  });

  it("keeps thoughts, words and calls in the order the run took them", () => {
    const recorder = new ActivityRecorder();
    recorder.see({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan" },
        { type: "text", text: "Looking first." },
        { type: "toolCall", id: "c1", name: "bash", arguments: {} },
      ],
    } as never);
    recorder.see(answered("c1", "ok"));
    recorder.see({
      role: "assistant",
      content: [
        { type: "text", text: "  " },
        { type: "toolCall", id: "c2", name: "read", arguments: {} },
      ],
    } as never);
    recorder.see(answered("c2", "ok"));
    recorder.see({
      role: "assistant",
      content: [{ type: "text", text: "x".repeat(9000) }],
    } as never);
    const steps = recorder.steps();
    expect(steps.slice(0, 4)).toEqual([
      { type: "thinking", text: "plan" },
      { type: "text", text: "Looking first." },
      { type: "tool", id: "c1" },
      { type: "tool", id: "c2" },
    ]);
    expect(steps[4]).toEqual({ type: "text", text: `${"x".repeat(8000)}…` });
  });

  it("keeps a call's arguments short: long strings cut, nested values flattened", () => {
    const recorder = new ActivityRecorder();
    recorder.see(
      asked("c1", "bash", {
        command: "x".repeat(1000),
        n: 3,
        nested: { a: "b" },
      }),
    );
    expect(recorder.list()[0]?.input).toEqual({
      command: `${"x".repeat(400)}…`,
      n: 3,
      nested: '{"a":"b"}',
    });
  });
});
