import { describe, expect, test } from "bun:test";
import { itemView } from "./items";

const task = { kind: "task", id: "t1", number: 12, title: "Ship it" };
function mcpCall(status: string, result: unknown) {
  return {
    type: "mcpToolCall",
    id: "i1",
    server: "tasks",
    tool: "create_task",
    status,
    arguments: { title: "Ship it" },
    result,
    error: null,
  };
}

describe("itemView", () => {
  test("passes on the ref a completed MCP call's result names", () => {
    const view = itemView(
      mcpCall("completed", {
        content: [{ type: "text", text: "{}" }],
        structuredContent: {},
        _meta: { "axp/ref": task },
      }),
      true,
    );
    expect(view?.name).toBe("tasks.create_task");
    expect(view?.ref).toEqual(task);
  });

  test("has no ref without one, while running or when failed", () => {
    const plain = { content: [], structuredContent: null, _meta: null };
    expect(itemView(mcpCall("completed", plain), true)?.ref).toBeUndefined();
    const named = { ...plain, _meta: { "axp/ref": task } };
    expect(itemView(mcpCall("inProgress", named), false)?.ref).toBeUndefined();
    expect(itemView(mcpCall("failed", named), true)?.ref).toBeUndefined();
    expect(itemView(mcpCall("inProgress", null), false)?.ref).toBeUndefined();
  });
});
