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

  test("passes on the operations an ended agenvo execute names, failed too", () => {
    const op = {
      action: "create_worktree",
      status: "completed",
      runtime: "paseo",
    };
    const result = {
      content: [{ type: "text", text: "Execution failed" }],
      _meta: { "axp/operations": [op] },
    };
    expect(itemView(mcpCall("completed", result), true)?.operations).toEqual([
      op,
    ]);
    expect(itemView(mcpCall("failed", result), true)?.operations).toEqual([op]);
    expect(
      itemView(mcpCall("inProgress", result), false)?.operations,
    ).toBeUndefined();
    const other = { ...result, _meta: { "axp/operations": "nope" } };
    expect(
      itemView(mcpCall("completed", other), true)?.operations,
    ).toBeUndefined();
  });
});
