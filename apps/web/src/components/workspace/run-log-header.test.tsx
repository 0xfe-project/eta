import type { TaskRunView } from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import {
  agentView,
  productHost,
  taskActivity,
  taskDetail,
} from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { TaskBoard } from "./task-board";

// The run log dialog's header: one line (face, name, state and time, which run), the workspace
// behind a button, and the run's timing strip that sends the log to a step.

const navigation = rstest.hoisted(() => ({
  task: "t1" as string | null,
  set: rstest.fn(),
}));
rstest.mock("./task-nav", () => ({
  useTaskNav: () => [navigation, navigation.set],
}));
rstest.mock("./use-groups", () => ({
  useGroups: () => ({ groups: [], current: undefined, groupId: null }),
  useOpenGroup: () => () => {},
}));

const T = 1_800_000_000_000;

const run = (overrides: Partial<TaskRunView> = {}): TaskRunView => ({
  id: "r1",
  agentId: null,
  status: "completed",
  queueReason: null,
  machineId: "m1",
  sessionId: "s1",
  continuesRunId: null,
  workspace: "/data/worktrees/p1/task-12",
  nudged: false,
  error: null,
  createdAt: T,
  startedAt: T,
  finishedAt: T + 248_000,
  ...overrides,
});

/** A run's session: a briefing, a message that calls two tools at once, their results, the end. */
const transcript = [
  {
    entryId: "e1",
    seq: 1,
    at: T + 100,
    message: { role: "user", content: "简报", timestamp: T + 100 },
  },
  {
    entryId: "e2",
    seq: 2,
    at: T + 10_000,
    message: {
      role: "assistant",
      api: "openai-responses",
      timestamp: T + 105,
      content: [
        { type: "text", text: "我先看看" },
        {
          type: "toolCall",
          id: "c1",
          name: "bash",
          arguments: { command: "bun test" },
        },
        {
          type: "toolCall",
          id: "c2",
          name: "read",
          arguments: { path: "a.ts" },
        },
      ],
    },
  },
  {
    entryId: "e3",
    seq: 3,
    at: T + 10_500,
    message: {
      role: "toolResult",
      toolCallId: "c2",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "a" }],
      timestamp: T + 10_500,
    },
  },
  {
    entryId: "e4",
    seq: 4,
    at: T + 15_000,
    message: {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "12 passed" }],
      timestamp: T + 15_000,
    },
  },
  {
    entryId: "e5",
    seq: 5,
    at: T + 20_000,
    message: {
      role: "assistant",
      api: "openai-responses",
      timestamp: T + 15_005,
      content: [{ type: "text", text: "完成了" }],
    },
  },
];

function host(runs: TaskRunView[], messages: readonly unknown[] = transcript) {
  const fake = productHost({
    agents: [agentView({ id: "a1", name: "Opus" })],
    tasks: [
      {
        task: taskDetail({
          id: "t1",
          number: 12,
          title: "执行记录弹窗",
          createdBy: { kind: "agent", agentId: "a1" },
          runStatus: runs.at(-1)!.status,
          workspace: {
            mode: "worktree",
            base: null,
            path: "/data/worktrees/p1/task-12",
            branch: "eta/task-12",
          },
          runs,
        }),
        // Each run's start is a line of the thread, with its log.
        activity: runs.map((each) =>
          taskActivity({
            id: `start-${each.id}`,
            kind: "run_started",
            runId: each.id,
            actor: { kind: "system", agentId: null },
          }),
        ),
      },
    ],
  });
  fake.target("sessions.s1", {
    core: { session: "s1", running: runs.at(-1)!.status === "running" },
    transcript: { messages },
  });
  fake.handle("sessions.resync", () => ({}));
  fake.hello();
  return fake;
}

/** Open the latest run's log; the dialog and its header's first line. */
async function open() {
  const { container } = await mount(<TaskBoard />);
  await flush();
  // A finished run's log is on its line of the thread, behind the fold of changes.
  const changes = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("条动态"),
  );
  if (changes) await click(changes);
  const buttons = [...container.querySelectorAll("button")].filter(
    (b) => b.textContent === "执行记录",
  );
  await click(buttons.at(-1));
  await flush();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const title = document.getElementById(
    dialog.getAttribute("aria-labelledby")!,
  )!;
  const line = dialog.querySelector<HTMLElement>(".h-7")!;
  return { dialog, title, line };
}

const strip = (dialog: HTMLElement) =>
  dialog.querySelector<HTMLElement>('[role="toolbar"]');

describe("the run log's header", () => {
  afterEach(async () => {
    await cleanup();
    setWire(undefined);
  });

  it("says who and how it went on one line, and keeps 执行记录 for screen readers", async () => {
    host([run()]);
    const { title, line } = await open();
    expect(title.textContent).toBe("执行记录");
    expect(title.className).toContain("sr-only");
    expect(line.textContent).toBe("Opus完成· 用时 4 分 08 秒展开工作区");
    // No task number, and no path on the line.
    expect(line.textContent).not.toContain("#12");
  });

  it("says a failed run failed, with how long it took", async () => {
    host([run({ status: "failed", finishedAt: T + 80_000 })]);
    const { line } = await open();
    expect(line.textContent).toContain("失败· 用时 1 分 20 秒");
  });

  it("counts the time of a run at work, and stripes the step still going", async () => {
    const startedAt = Date.now() - 192_000;
    host(
      [run({ status: "running", startedAt, finishedAt: null })],
      transcript.slice(0, 2).map((row) => ({
        ...row,
        at: row.at - T + startedAt,
        message: {
          ...row.message,
          timestamp: row.message.timestamp - T + startedAt,
        },
      })),
    );
    const { dialog, line } = await open();
    expect(line.textContent).toMatch(/^Opus运行中3:1[23]展开工作区$/);
    // The two calls have no results yet: both are still going, so both are drawn striped.
    const going = [
      ...dialog.querySelectorAll<HTMLElement>(".run-segment"),
    ].filter((segment) => segment.style.background.includes("repeating"));
    expect(going.length).toBeGreaterThan(0);
    expect(
      dialog.querySelector('[role="toolbar"]')?.getAttribute("aria-label"),
    ).toMatch(/^3 步，用时 3:1[23]$/);
  });

  it("says which run it is only when the task has run more than once", async () => {
    host([
      run({ id: "r0", status: "failed", finishedAt: T + 1000 }),
      run({ id: "r1" }),
    ]);
    const { line } = await open();
    expect(line.textContent).toContain("· 第 2 次");
  });

  it("draws no strip for a transcript with no times", async () => {
    host(
      [run()],
      transcript.map((row) => ({
        ...row,
        at: 0,
        message: { ...row.message, timestamp: 0 },
      })),
    );
    const { dialog } = await open();
    expect(strip(dialog)).toBeNull();
    expect(dialog.textContent).not.toContain("展开");
    // The log is still there.
    expect(dialog.textContent).toContain("我先看看");
  });
});

describe("the run's timing strip", () => {
  afterEach(async () => {
    await cleanup();
    setWire(undefined);
  });

  it("has a step per segment, a legend with each kind's time, and a summary to read out", async () => {
    host([run()]);
    const { dialog } = await open();
    const toolbar = strip(dialog)!;
    // From the run's start to its end, as the header counts it.
    expect(toolbar.getAttribute("aria-label")).toBe("4 步，用时 4:08");
    expect(dialog.getAttribute("aria-describedby")).not.toBeNull();
    const labels = [...toolbar.querySelectorAll("button")].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(labels).toEqual([
      "生成，生成，我先看看，0:00 开始，用时 9.9s",
      "read，读取 / 搜索，a.ts，0:10 开始，用时 500ms",
      "bash，命令，bun test，0:10 开始，用时 5.0s",
      "生成，生成，完成了，0:15 开始，用时 5.0s",
    ]);
    const legend = toolbar.nextElementSibling!;
    expect(
      [...legend.querySelectorAll("li")].map((li) => li.textContent),
    ).toEqual(["生成14s", "命令5.0s", "读取 / 搜索500ms"]);
  });

  it("sends the log to the step picked, and opens the waterfall", async () => {
    host([run()]);
    const { dialog } = await open();
    const bash = [...strip(dialog)!.querySelectorAll("button")].find((b) =>
      b.getAttribute("aria-label")?.startsWith("bash"),
    );
    await click(bash);
    await flush();
    const hit = dialog.querySelectorAll("[data-hit]");
    expect(hit).toHaveLength(1);
    expect(hit[0]!.getAttribute("data-block")).toBe("c1");
    expect(hit[0]!.textContent).toContain("bun test");
    // The waterfall: a row per step, the calls made together starting together.
    const rows = [
      ...dialog.querySelectorAll<HTMLElement>("ol[aria-label='每一步'] button"),
    ];
    expect(rows.map((row) => row.firstElementChild!.textContent)).toEqual([
      "生成 · 我先看看",
      "bash · bun test",
      "read · a.ts",
      "生成 · 完成了",
    ]);
    const bar = (row: HTMLElement) =>
      row.querySelector<HTMLElement>(".absolute")!.style.left;
    expect(bar(rows[1]!)).toBe(bar(rows[2]!));
    expect(rows[1]!.getAttribute("aria-current")).toBe("step");
    // A row sends the log there too.
    await click(rows[3]);
    expect(dialog.querySelector("[data-hit]")?.getAttribute("data-block")).toBe(
      `at${T + 15_005}:0`,
    );
  });

  it("opens and closes the waterfall from its button", async () => {
    host([run()]);
    const { dialog } = await open();
    const toggle = [...dialog.querySelectorAll("button")].find(
      (b) => b.textContent === "展开",
    )!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("收起");
    expect(dialog.querySelector("ol[aria-label='每一步']")).not.toBeNull();
    await click(toggle);
    expect(dialog.querySelector("ol[aria-label='每一步']")).toBeNull();
  });

  it("is one tab stop, walked with the arrow keys", async () => {
    host([run()]);
    const { dialog } = await open();
    const buttons = [...strip(dialog)!.querySelectorAll("button")];
    expect(buttons.map((b) => b.tabIndex)).toEqual([0, -1, -1, -1]);
    await act(async () => buttons[0]!.focus());
    await act(async () => {
      buttons[0]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons.map((b) => b.tabIndex)).toEqual([-1, 0, -1, -1]);
    // Focus says what the step was, as hovering does.
    expect(dialog.querySelector('[role="tooltip"]')?.textContent).toBe(
      "read 读取 / 搜索a.ts0:10 开始 · 用时 500ms",
    );
    await act(async () => {
      buttons[1]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(buttons[3]);
  });
});
