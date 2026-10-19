import type { AgentMessage } from "@eta/core";
import { describe, expect, it } from "vitest";
import { ActivityRecorder, shortInput } from "../src/activity";

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

describe("shortInput", () => {
  it("cuts long strings and flattens nested values", () => {
    const kept = shortInput({
      command: "x".repeat(1000),
      n: 3,
      nested: { a: "b" },
    }) as Record<string, unknown>;
    expect((kept.command as string).length).toBe(401);
    expect(kept.n).toBe(3);
    expect(kept.nested).toBe('{"a":"b"}');
  });
});

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
});
