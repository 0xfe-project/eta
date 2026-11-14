import type { AgentMessage, ViewMessageRow } from "@eta/client-contracts";
import { describe, expect, it } from "@rstest/core";
import {
  kindTotals,
  replyRows,
  rowsBetween,
  runFromOfCall,
  runTiming,
  stripSegments,
  toolKind,
} from "./run-timing";

let seq = 0;
const row = (at: number, message: object): ViewMessageRow => {
  seq += 1;
  return { entryId: `e${seq}`, seq, at, message: message as AgentMessage };
};
const user = (at: number, text = "go") =>
  row(at, { role: "user", content: text, timestamp: at });
const call = (id: string, name: string, args: object = {}) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});
/** eta's own loop: stamped when the stream opened, written when it was done. */
const eta = (opened: number, at: number, content: object[]) =>
  row(at, {
    role: "assistant",
    api: "openai-responses",
    content,
    timestamp: opened,
  });
/** A runtime through oar: stamped at its first fact, written when its first call came back. */
const oar = (api: string, stamp: number, at: number, content: object[]) =>
  row(at, { role: "assistant", api, content, timestamp: stamp });
const result = (at: number, id: string, name = "bash") =>
  row(at, {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: at,
  });

const spans = (rows: ViewMessageRow[], options = {}) =>
  runTiming(rows, options)?.steps.map((step) => [
    step.kind,
    step.name,
    step.start,
    step.end,
    ...(step.running ? ["running"] : []),
  ]);

describe("a run's timing, from eta's own loop", () => {
  it("is generation from the message before, then each call to its result", () => {
    const rows = [
      user(1000),
      eta(1005, 5000, [
        { type: "thinking", thinking: "look first" },
        call("c1", "esmrun", { script: "await $`ls`" }),
      ]),
      result(8000, "c1", "esmrun"),
      eta(8005, 11000, [{ type: "text", text: "Done." }]),
    ];
    const timing = runTiming(rows)!;
    expect(timing.precision).toBe("full");
    expect([timing.start, timing.end]).toEqual([1000, 11000]);
    expect(spans(rows)).toEqual([
      ["model", "", 1000, 5000],
      ["shell", "esmrun", 5000, 8000],
      ["model", "", 8000, 11000],
    ]);
    // A click on a step leads to the blocks the log draws it as.
    expect(timing.steps.map((step) => step.blocks)).toEqual([
      ["at1005:0", "c1"],
      ["c1"],
      ["at8005:0"],
    ]);
    expect(timing.steps[0]!.detail).toBe("look first");
    expect(timing.steps[1]!.detail).toBe("await $`ls`");
  });

  it("starts calls made together at the same moment, each ending at its own result", () => {
    const rows = [
      user(1),
      eta(1, 2000, [call("a", "read"), call("b", "grep"), call("c", "bash")]),
      result(2100, "a", "read"),
      result(2300, "b", "grep"),
      result(6000, "c"),
      eta(6001, 7000, [{ type: "text", text: "ok" }]),
    ];
    expect(spans(rows)).toEqual([
      ["model", "", 1, 2000],
      ["read", "read", 2000, 2100],
      ["read", "grep", 2000, 2300],
      ["shell", "bash", 2000, 6000],
      // The next generation starts after the last of them.
      ["model", "", 6000, 7000],
    ]);
    // The strip gives each its own stretch of wall time; the read that ended inside another
    // read takes none.
    const segments = stripSegments(runTiming(rows)!).map((segment) => [
      segment.step.name || "model",
      segment.from,
      segment.to,
    ]);
    expect(segments).toEqual([
      ["model", 1, 2000],
      ["read", 2000, 2100],
      ["grep", 2100, 2300],
      ["bash", 2300, 6000],
      ["model", 6000, 7000],
    ]);
    expect(kindTotals(runTiming(rows)!.steps).get("read")).toBe(400);
  });

  it("runs a call still waiting for its result, and a message still streamed, to now", () => {
    const rows = [
      user(1),
      eta(1, 1000, [call("c1", "bash", { command: "sleep 60" })]),
    ];
    expect(spans(rows, { now: 5000 })).toEqual([
      ["model", "", 1, 1000],
      ["shell", "bash", 1000, 5000, "running"],
    ]);
    const done = [...rows, result(6000, "c1")];
    const streaming = {
      role: "assistant",
      api: "openai-responses",
      content: [{ type: "text", text: "writ" }],
      timestamp: 6001,
    } as AgentMessage;
    const live = runTiming(done, { streaming, now: 9000 })!;
    expect(live.end).toBe(9000);
    expect(spans(done, { streaming, now: 9000 })!.at(-1)).toEqual([
      "model",
      "",
      6000,
      9000,
      "running",
    ]);
    expect(live.steps.at(-1)!.blocks).toEqual(["at6001:0"]);
  });

  it("does not draw a streamed message the transcript already has", () => {
    const rows = [user(1), eta(10, 1000, [{ type: "text", text: "hi" }])];
    const streaming = rows[1]!.message;
    expect(spans(rows, { streaming, now: 1500 })).toEqual([
      ["model", "", 1, 1000],
    ]);
  });

  it("ends a call that never came back, in a finished run, where the next thing happened", () => {
    const rows = [
      user(1),
      eta(1, 1000, [call("c1", "bash")]),
      row(4000, {
        role: "assistant",
        api: "openai-responses",
        content: [],
        stopReason: "aborted",
        timestamp: 4000,
      }),
    ];
    expect(spans(rows)).toEqual([
      ["model", "", 1, 1000],
      ["shell", "bash", 1000, 4000],
      ["model", "", 1000, 4000],
    ]);
    expect(runTiming(rows)!.steps[2]!.blocks).toEqual(["at4000:error"]);
  });

  it("runs from when the run started to when it ended, when those are outside its rows", () => {
    const rows = [user(1000), eta(1001, 3000, [{ type: "text", text: "x" }])];
    const timing = runTiming(rows, { start: 900, end: 9000 })!;
    expect([timing.start, timing.end]).toEqual([900, 9000]);
    // A run at work runs to now, whatever it says about its end.
    expect(runTiming(rows, { start: 900, now: 4000 })!.end).toBe(4000);
  });

  it("is nothing when the rows carry no times", () => {
    const rows = [
      row(0, { role: "user", content: "go" }),
      row(0, { role: "assistant", content: [{ type: "text", text: "x" }] }),
    ];
    expect(runTiming(rows)).toBeUndefined();
    expect(runTiming([])).toBeUndefined();
    // One moment is no stretch of time either.
    expect(runTiming([user(5)])).toBeUndefined();
  });

  it("falls back to a message's own time for a row that does not say when it was written", () => {
    const rows = [
      user(1000),
      row(Number.NaN, {
        role: "assistant",
        content: [{ type: "text", text: "x" }],
        timestamp: 3000,
      }),
    ];
    expect(spans(rows)).toEqual([["model", "", 1000, 3000]]);
  });
});

describe("a run's timing, through oar", () => {
  it("ends generation at the message's first fact and runs the call from there", () => {
    const rows = [
      user(1),
      // Claude Code: the row is written when the call comes back, after the command ran.
      oar("oar-claude", 3600, 10100, [
        call("t1", "Bash", { command: "sleep 6" }),
      ]),
      result(10150, "t1", "Bash"),
      oar("oar-claude", 12000, 12500, [{ type: "text", text: "Done." }]),
    ];
    const timing = runTiming(rows)!;
    expect(timing.precision).toBe("full");
    expect(spans(rows)).toEqual([
      ["model", "", 1, 3600],
      ["shell", "Bash", 3600, 10150],
      ["model", "", 10150, 12000],
    ]);
  });

  it("names Codex's tools by what they do", () => {
    const rows = [
      user(1),
      oar("oar-codex", 500, 4000, [
        call("x1", "commandExecution", { command: "ls" }),
      ]),
      result(4010, "x1", "commandExecution"),
      oar("oar-codex", 5000, 5100, [call("x2", "fileChange")]),
      result(5110, "x2", "fileChange"),
    ];
    expect(spans(rows)!.map((span) => span[0])).toEqual([
      "model",
      "shell",
      "model",
      "edit",
    ]);
  });

  it("tells only the model from its tools for a runtime that was not measured", () => {
    const rows = [
      user(1),
      oar("oar-opencode", 500, 4000, [call("o1", "bash"), call("o2", "read")]),
      result(4010, "o1"),
      result(4020, "o2", "read"),
    ];
    const timing = runTiming(rows)!;
    expect(timing.precision).toBe("coarse");
    expect(timing.steps.map((step) => step.kind)).toEqual([
      "model",
      "tool",
      "tool",
    ]);
  });

  it("runs the calls of a message still open to now", () => {
    const rows = [user(1)];
    const streaming = {
      role: "assistant",
      api: "oar-claude",
      content: [call("t1", "Bash", { command: "sleep 60" })],
      timestamp: 2000,
    } as AgentMessage;
    expect(spans(rows, { streaming, now: 9000 })).toEqual([
      ["model", "", 1, 2000],
      ["shell", "Bash", 2000, 9000, "running"],
    ]);
  });
});

describe("tool kinds", () => {
  it("go by name, whatever the runtime's spelling", () => {
    expect(
      ["Bash", "bash", "exec_command", "commandExecution"].map((n) =>
        toolKind(n),
      ),
    ).toEqual(["shell", "shell", "shell", "shell"]);
    expect(
      [
        "Read",
        "grep",
        "Glob",
        "web_fetch",
        "WebSearch",
        "mcp__eta__web_fetch",
      ].map((n) => toolKind(n)),
    ).toEqual(["read", "read", "read", "read", "read", "read"]);
    expect(
      ["Edit", "MultiEdit", "write", "apply_patch", "fileChange"].map((n) =>
        toolKind(n),
      ),
    ).toEqual(["edit", "edit", "edit", "edit", "edit"]);
    expect(
      ["finish_task", "publish_artifact", "TodoWrite", ""].map((n) =>
        toolKind(n),
      ),
    ).toEqual(["other", "other", "other", "other"]);
  });

  it("go by what an eta script does", () => {
    const script = (text: string) => toolKind("esmrun", { script: text });
    expect(script("await $`bun test`")).toBe("shell");
    expect(script('await view("a.ts"); await edit("a.ts", "x", "y")')).toBe(
      "edit",
    );
    expect(script('await search("TODO")')).toBe("read");
    expect(script("1 + 1")).toBe("other");
    expect(toolKind("esmrunandkeep", { script: "await $`ls`" })).toBe("shell");
    expect(toolKind("esmrun")).toBe("other");
  });
});

describe("the rows of a run", () => {
  it("of a task run are the ones written while it went", () => {
    const rows = [user(100), user(500), user(900)];
    expect(rowsBetween(rows, 400, 800)).toEqual([rows[1]]);
    expect(rowsBetween(rows, 400, null)).toEqual([rows[1], rows[2]]);
  });

  it("of a group reply run from its briefing to the next reply's", () => {
    seq = 0;
    const rows = [
      user(0, "earlier"),
      eta(1, 2, [{ type: "text", text: "earlier reply" }]),
      user(10, "this one"),
      eta(11, 20, [call("c", "bash")]),
      result(30, "c"),
      eta(31, 40, [{ type: "text", text: "done" }]),
      user(50, "next one"),
      eta(51, 60, [{ type: "text", text: "next reply" }]),
    ];
    expect(replyRows(rows, 2).map((r) => r.seq)).toEqual([3, 4, 5, 6]);
  });

  it("of a finished group reply are found by a call it kept, when its row lost where it started", () => {
    seq = 0;
    const rows = [
      user(1, "earlier"),
      eta(2, 3, [{ type: "text", text: "earlier reply" }]),
      user(10, "this one"),
      eta(11, 20, [call("c", "bash")]),
      result(30, "c"),
      eta(31, 40, [{ type: "text", text: "done" }]),
      user(50, "next one"),
    ];
    const from = runFromOfCall(rows, "c")!;
    expect(from).toBe(2);
    expect(replyRows(rows, from).map((r) => r.seq)).toEqual([3, 4, 5, 6]);
    expect(runFromOfCall(rows, "gone")).toBeUndefined();
  });
});
