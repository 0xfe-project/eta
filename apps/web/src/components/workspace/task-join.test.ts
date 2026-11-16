import { describe, expect, it } from "@rstest/core";
import { newTaskMode, newTaskStartsAtHead, splitJoinSteps } from "./task-join";
import { parseSplit } from "./task-split";
import { board } from "./task-tree-fixture";

describe("where a new join will work", () => {
  const tasks = board([
    { number: 1, title: "old, local" },
    { number: 2, title: "newer, worktree" },
    { number: 3, title: "another project" },
  ]).map((t, i) => ({
    ...t,
    conversationId: i === 2 ? "c2" : "c1",
    workspaceMode: (["local", "worktree", "local"] as const)[i],
  }));
  const projectOf = (t: { conversationId: string | null }) =>
    t.conversationId === "c1" ? "p1" : "p2";

  it("is the parent's mode, else that of the project's newest task, else not known", () => {
    expect(newTaskMode(tasks[0], "p1", tasks, projectOf)).toBe("local");
    expect(newTaskMode(undefined, "p1", tasks, projectOf)).toBe("worktree");
    expect(newTaskMode(undefined, "p2", tasks, projectOf)).toBe("local");
    expect(newTaskMode(undefined, "p3", tasks, projectOf)).toBeUndefined();
    expect(newTaskMode(undefined, undefined, tasks, projectOf)).toBeUndefined();
  });

  it("starts at HEAD with two prerequisites or more, in a worktree only", () => {
    expect(newTaskStartsAtHead("worktree", 2)).toBe(true);
    expect(newTaskStartsAtHead("worktree", 1)).toBe(false);
    expect(newTaskStartsAtHead("local", 3)).toBe(false);
    expect(newTaskStartsAtHead(undefined, 3)).toBe(false);
  });

  it("names each split step that waits for a parallel one", () => {
    const lines = parseSplit("a\nb\n→ c\n→ d\ne\n→ f");
    expect(splitJoinSteps("worktree", lines)).toEqual([2, 4]);
    expect(splitJoinSteps("local", lines)).toEqual([]);
    expect(splitJoinSteps("worktree", parseSplit("a\n→ b\n→ c"))).toEqual([]);
  });
});
