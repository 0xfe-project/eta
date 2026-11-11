// The board of the design, and the ops answered as `apps/eta/src/tasks/board.ts` answers them.
//
// Scenarios (`host.scenario`):
// - `empty`, `uninitialized`: nothing on the board (05a).
// - `no-github`: the host has no `github` plugin, so no PR surface anywhere.
// - `pr-states`: #128 carries every PR of 06e2. #472's merge gets no answer, the first completion
//   of the task fails, #460 cannot be read.
// - `comment-fails`: the first comment on a task does not arrive.
// - `task-gone`: #135 is on the board but `tasks.task-135` is missing (06i).
// - `task-loading`: `tasks.task-135` never gets its sections (06i).

import type {
  BoardTaskDetail,
  BoardTaskStatus,
  BoardTaskView,
  GitHubPull,
  GitHubStatus,
  TaskActivityKind,
  TaskActivityView,
  TaskActor,
  TaskArgs,
  TaskDraftData,
  TaskPullView,
  TaskResults,
  TaskRunStatus,
  TaskRunView,
} from "@eta/client-contracts";
import type { FakeHost } from "../fake-host";
import { minutesAgo } from "./base";

const USER: TaskActor = { kind: "user", agentId: null };
const SYSTEM: TaskActor = { kind: "system", agentId: null };
const agent = (id: string): TaskActor & { kind: "agent" } => ({
  kind: "agent",
  agentId: `agent-${id}`,
});

/** A time of day, `days` days back. */
function at(days: number, hours: number, minutes: number): number {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hours, minutes, 0, 0);
  return date.getTime();
}

let serial = 0;
const nextId = (prefix: string) => {
  serial += 1;
  return `${prefix}-${serial}`;
};

function entry(
  kind: TaskActivityKind,
  actor: TaskActor,
  createdAt: number,
  fields: {
    body?: string;
    runId?: string;
    data?: Record<string, unknown>;
  } = {},
): TaskActivityView {
  return {
    id: nextId("activity"),
    kind,
    runId: fields.runId ?? null,
    actor,
    body: fields.body ?? null,
    data: fields.data ?? {},
    createdAt,
  };
}

function run(
  id: string,
  status: TaskRunStatus,
  fields: Partial<TaskRunView> = {},
): TaskRunView {
  const going = status === "running";
  return {
    id,
    agentId: null,
    status,
    queueReason: null,
    machineId: "mac-studio",
    sessionId: status === "queued" ? null : `session-${id}`,
    continuesRunId: null,
    workspace: null,
    nudged: false,
    error: null,
    createdAt: minutesAgo(600),
    startedAt: status === "queued" ? null : minutesAgo(600),
    finishedAt: going || status === "queued" ? null : minutesAgo(30),
    ...fields,
  };
}

/** `runStatus`: the executor's newest run; a mentioned agent answering is not the task running. */
const newestOwn = (runs: TaskRunView[]): TaskRunStatus | null =>
  runs.filter((item) => item.agentId === null).at(-1)?.status ?? null;

interface Fixture {
  id: string;
  number: number;
  title: string;
  status: BoardTaskStatus;
  by: TaskActor & { kind: "agent" };
  conversationId?: string | null;
  updatedAt: number;
  createdAt?: number;
  description?: string;
  runs?: TaskRunView[];
  activity?: TaskActivityView[];
  projectId?: string;
  branch?: string;
  path?: string;
}

function detail(task: Fixture): {
  task: BoardTaskDetail;
  activity: TaskActivityView[];
} {
  const runs = task.runs ?? [];
  const activity = task.activity ?? [];
  const conversationId = task.conversationId ?? null;
  return {
    task: {
      id: task.id,
      number: task.number,
      title: task.title,
      status: task.status,
      createdBy: task.by,
      assigneeAgentId: null,
      conversationId,
      runStatus: newestOwn(runs),
      comments: activity.filter((a) => a.kind === "comment").length,
      createdAt: task.createdAt ?? task.updatedAt,
      updatedAt: task.updatedAt,
      description: task.description ?? "",
      artifacts: [],
      projectId: task.projectId ?? "eta",
      workspace: {
        mode: "worktree",
        base: null,
        path: task.path ?? null,
        branch: task.branch ?? null,
      },
      originConversationId: conversationId,
      runs,
    },
    activity,
  };
}

const WORKTREE_128 = "/Users/eric/.eta/worktrees/eta/task-128";

const replay = run("run-128", "completed", {
  workspace: WORKTREE_128,
  startedAt: at(1, 18, 22),
  finishedAt: at(0, 9, 12),
});

const FEATURED: Fixture[] = [
  {
    id: "task-131",
    number: 131,
    title: "Board column width remembers last drag",
    status: "in_progress",
    by: agent("mori"),
    conversationId: "board",
    updatedAt: minutesAgo(0),
    createdAt: at(0, 9, 20),
    description:
      "Column widths are written to localStorage and restored after refresh.",
    runs: [
      run("run-131", "running", {
        machineId: "gpu-box",
        workspace: "/home/akrc",
        startedAt: at(0, 9, 21),
      }),
      run("run-131b", "queued", {
        agentId: "agent-xiaoman",
        queueReason: "task_busy",
        createdAt: minutesAgo(1),
      }),
    ],
    activity: [
      entry("created", agent("mori"), at(0, 9, 20)),
      entry("run_started", SYSTEM, at(0, 9, 21), { runId: "run-131" }),
    ],
  },
  {
    id: "task-133",
    number: 133,
    title: "Run history supports pagination",
    status: "in_progress",
    by: agent("xiaoman"),
    conversationId: "board",
    updatedAt: minutesAgo(2),
    description:
      "The view only carries the latest 200 entries; scrolling up uses sessions.history to fetch older ones.",
    runs: [run("run-133", "queued", { queueReason: "machine_full" })],
    activity: [entry("created", agent("xiaoman"), minutesAgo(2))],
  },
  {
    id: "task-128",
    number: 128,
    title: "Backfill lost frames after reconnect",
    status: "in_review",
    by: agent("ache"),
    conversationId: "wire",
    updatedAt: minutesAgo(8),
    createdAt: at(1, 18, 20),
    description:
      "After a disconnect, the client sends the last seq it received, and the host replays from that row forward, then reattaches to live frames.\n\n## Definition of done\n- No frame loss across 200 kill-and-reconnect cycles\n- Order stays intact during backfill",
    branch: "task/128-replay",
    path: WORKTREE_128,
    runs: [replay],
    activity: [
      entry("created", agent("ache"), at(1, 18, 20), {
        data: { status: "todo" },
      }),
      entry("run_queued", SYSTEM, at(1, 18, 20), { runId: "run-128" }),
      entry("status", agent("ache"), at(1, 18, 21), {
        data: { from: "todo", to: "in_progress" },
      }),
      entry("run_started", SYSTEM, at(1, 18, 22), { runId: "run-128" }),
      entry("title", agent("ache"), at(1, 18, 30), {
        data: {
          from: "Resend lost frames",
          to: "Resend lost frames after reconnect",
        },
      }),
      entry("description", agent("ache"), at(1, 18, 31)),
      entry("conversation", USER, at(1, 19, 0), {
        data: { from: null, to: "wire" },
      }),
      entry("run_nudged", SYSTEM, at(0, 8, 58), { runId: "run-128" }),
      entry("comment", agent("ache"), at(0, 9, 12), {
        body: "Killed the process and reconnected 200 times, no frames lost. All tests pass, ready for your acceptance.",
      }),
      entry("status", agent("ache"), at(0, 9, 12), {
        data: { from: "in_progress", to: "in_review" },
      }),
    ],
  },
  {
    id: "task-129",
    number: 129,
    title: "Archive backup to nas",
    status: "blocked",
    by: agent("ache"),
    conversationId: "wire",
    updatedAt: minutesAgo(20),
    createdAt: at(1, 22, 4),
    description:
      "Every week, pack ~/.eta and archive it to nas, keeping the latest four copies.",
    runs: [
      run("run-129", "failed", {
        machineId: "nas",
        error: "nas connection timed out",
      }),
      run("run-129b", "queued", {
        machineId: "nas",
        queueReason: "machine_offline",
        continuesRunId: "run-129",
      }),
    ],
    activity: [
      entry("created", agent("ache"), at(1, 22, 4)),
      entry("run_failed", SYSTEM, minutesAgo(30), {
        runId: "run-129",
        body: "nas connection timed out",
      }),
      entry("status", agent("ache"), minutesAgo(29), {
        data: { from: "in_progress", to: "blocked" },
      }),
      entry("comment", agent("ache"), minutesAgo(20), {
        body: "nas has been unreachable since last night. Wait for it to come back, or store the archive on gpu-box for now?",
      }),
    ],
  },
  {
    id: "task-41",
    number: 41,
    title: "Swap homepage first screen to new copy",
    status: "in_review",
    by: agent("mori"),
    conversationId: "redesign",
    updatedAt: minutesAgo(60),
    description:
      "Use the copy finalized last week, within two lines on mobile.",
    projectId: "site",
    runs: [run("run-41", "completed", { machineId: "mb-air" })],
    activity: [entry("created", agent("mori"), minutesAgo(600))],
  },
  {
    id: "task-135",
    number: 135,
    title: "Shortcut list on settings page",
    status: "todo",
    by: agent("ache"),
    updatedAt: minutesAgo(1500),
    activity: [entry("created", agent("ache"), minutesAgo(1500))],
  },
  {
    id: "task-118",
    number: 118,
    title: "Artifacts support PDF preview",
    status: "backlog",
    by: agent("mori"),
    conversationId: "redesign",
    updatedAt: minutesAgo(3 * 1440 + 30),
  },
  {
    id: "task-126",
    number: 126,
    title: "site supports SPA fallback",
    status: "done",
    by: agent("ache"),
    conversationId: "wire",
    updatedAt: minutesAgo(1500),
  },
  {
    id: "task-124",
    number: 124,
    title: "Skeleton screen no longer flickers",
    status: "done",
    by: agent("mori"),
    conversationId: "board",
    updatedAt: minutesAgo(2 * 1440 + 30),
  },
  {
    id: "task-97",
    number: 97,
    title: "Legacy Settings Page Migration",
    status: "cancelled",
    by: agent("xiaoman"),
    updatedAt: minutesAgo(9 * 1440),
  },
];

/** The board's long tail: 05 counts 38 tasks, and 05c splits them between the groups. */
function filler(): Fixture[] {
  const groups = [
    ...Array(1).fill("wire"),
    ...Array(3).fill("board"),
    ...Array(7).fill("redesign"),
  ];
  const row = (
    number: number,
    status: BoardTaskStatus,
    title: string,
  ): Fixture => ({
    id: `task-${number}`,
    number,
    title,
    status,
    by: agent(["ache", "mori", "xiaoman"][number % 3] ?? "ache"),
    conversationId: groups.shift() ?? null,
    updatedAt: minutesAgo(number * 700),
  });
  return [
    row(20, "backlog", "Desktop Tray Menu"),
    row(21, "backlog", "Export Full Conversation"),
    row(22, "cancelled", "Legacy Notification Center"),
    ...Array.from({ length: 25 }, (_, index) =>
      row(30 + index, "done", `Archived Item ${index + 1}`),
    ),
  ];
}

/** 06h: the transcript of #128's run, in the shapes a session's rows have. */
function replayLog(): unknown[] {
  let seq = 0;
  const say = (message: object) => {
    seq += 1;
    return {
      entryId: `entry-${seq}`,
      seq,
      at: at(1, 18, 22) + seq * 1000,
      message,
    };
  };
  const text = (words: string) =>
    say({
      role: "assistant",
      content: [{ type: "text", text: words }],
      timestamp: at(1, 18, 22),
      stopReason: "stop",
    });
  const tool = (
    id: string,
    name: string,
    input: object,
    output: string,
    isError = false,
  ) => [
    say({
      role: "assistant",
      content: [{ type: "toolCall", id, name, arguments: input }],
      timestamp: at(1, 18, 22),
      stopReason: "toolUse",
    }),
    say({
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text: output }],
      isError,
      timestamp: at(1, 18, 22),
    }),
  ];
  return [
    text(
      "Check the current reconnect path first, then decide where to resume replay.",
    ),
    ...["wire.ts", "reconnect.ts", "replay.ts", "hello.ts"].flatMap(
      (file, index) =>
        tool(`read-${index}`, "read", { file_path: `src/${file}` }, "…"),
    ),
    ...tool(
      "bash-1",
      "bash",
      { command: "bun test wire" },
      "51 pass 0 fail [4.21s]",
    ),
    ...tool(
      "bash-2",
      "bash",
      { command: "bun run migrate" },
      "index missing",
      true,
    ),
    text(
      "Build indexes on the test database before migration, then rerun after changes.",
    ),
    ...["0042_seq.sql", "replay.ts"].flatMap((file, index) =>
      tool(`edit-${index}`, "edit", { file_path: `src/${file}` }, "ok"),
    ),
  ];
}

const REPO = "https://github.com/akrc/eta/pull";
const url = (number: number) => `${REPO}/${number}`;

interface PullFixture extends GitHubPull {
  number: number;
}

function pull(
  number: number,
  title: string,
  state: GitHubPull["state"],
  additions: number,
  deletions: number,
  merge?: GitHubPull["merge"],
  reason?: string,
): PullFixture {
  return {
    url: url(number),
    number,
    title,
    state,
    additions,
    deletions,
    headSha: `sha${number}`,
    ...(merge === undefined ? {} : { merge }),
    ...(reason === undefined ? {} : { reason }),
  };
}

const REPLAY = () =>
  pull(472, "Replay Missing Frames", "open", 182, 40, "ready");
const NOT_READY = () =>
  pull(
    470,
    "Migration Script",
    "open",
    20,
    0,
    "blocked",
    "Checks haven't passed yet, GitHub won't allow merging now.",
  );

function pulls(scenario: string): Record<string, PullFixture[]> {
  if (scenario === "pr-states")
    return {
      "task-128": [
        REPLAY(),
        NOT_READY(),
        pull(466, "Log Noise Reduction", "merged", 12, 30),
        pull(465, "Panel Width", "merged", 8, 2),
        pull(460, "Board Drag", "open", 1, 1),
      ],
    };
  return { "task-128": [REPLAY()], "task-41": [NOT_READY()] };
}

const CONNECTED: GitHubStatus = {
  state: "ready",
  app: null,
  installations: [],
  error: null,
  user: null,
  oauth: true,
  checked: true,
};

function installGithub(host: FakeHost): void {
  const scenario = host.scenario;
  if (scenario === "no-github" || scenario === "uninitialized") return;
  host.mounted = [...host.mounted, { name: "github", source: "bundled" }];
  const byTask = pulls(scenario);
  const fixtures = new Map(
    Object.values(byTask)
      .flat()
      .map((fixture) => [fixture.url, fixture]),
  );
  const views: TaskPullView[] = Object.entries(byTask).flatMap(
    ([taskId, list]) =>
      list.map((fixture) => ({
        taskId,
        url: fixture.url,
        title: fixture.title,
        number: fixture.number,
        openedAt: minutesAgo(90),
      })),
  );
  host.set("github", { state: CONNECTED, pulls: views });
  host.on("github.pull", (args: { url: string }) => {
    const found = fixtures.get(args.url);
    if (found === undefined || found.number === 460)
      throw new Error("GITHUB_UNAVAILABLE");
    return found;
  });
  host.on("github.merge", async (args: { url: string; headSha: string }) => {
    const found = fixtures.get(args.url);
    if (found === undefined) throw new Error("PR_NOT_FOUND");
    if (found.headSha !== args.headSha) throw new Error("STALE_HEAD");
    await new Promise((done) => setTimeout(done, 300));
    // No answer comes back: the wire's own timeout tells the page.
    if (scenario === "pr-states" && found.number === 472)
      await new Promise(() => undefined);
    const { merge: _merge, reason: _reason, ...open } = found;
    const merged: PullFixture = { ...open, state: "merged" };
    fixtures.set(args.url, merged);
    return merged;
  });
}

function installBoard(host: FakeHost): void {
  const scenario = host.scenario;
  const toList = (task: BoardTaskDetail): BoardTaskView => {
    const {
      description: _description,
      artifacts: _artifacts,
      projectId: _projectId,
      workspace: _workspace,
      originConversationId: _origin,
      runs: _runs,
      ...view
    } = task;
    return view;
  };
  const target = (id: string) => `tasks.${id}`;
  const read = (id: string): BoardTaskDetail => {
    const task = host.section<BoardTaskDetail>(target(id), "task");
    if (task === undefined) throw new Error(`no such task: ${id}`);
    return task;
  };
  const activity = (id: string) =>
    host.section<TaskActivityView[]>(target(id), "activity") ?? [];
  const list = () => host.section<BoardTaskView[]>("tasks", "list") ?? [];

  /** A change: the task, and its place at the top of the board. */
  const write = (task: BoardTaskDetail): BoardTaskDetail => {
    const moved = { ...task, updatedAt: Date.now() };
    const kept = list().filter((other) => other.id !== task.id);
    host.patch(target(task.id), "task", moved);
    host.patch("tasks", "list", [toList(moved), ...kept]);
    return moved;
  };
  const record = (id: string, added: TaskActivityView): void =>
    host.patch(target(id), "activity", [...activity(id), added]);
  const withRuns = (
    task: BoardTaskDetail,
    runs: TaskRunView[],
  ): BoardTaskDetail => ({
    ...task,
    runs,
    runStatus: newestOwn(runs),
  });
  const active = (status: TaskRunStatus) =>
    status === "queued" || status === "starting" || status === "running";
  const workable = (status: BoardTaskStatus) =>
    status === "todo" ||
    status === "in_progress" ||
    status === "in_review" ||
    status === "blocked";

  const startRun = (
    task: BoardTaskDetail,
    fields: Partial<TaskRunView> = {},
  ): TaskRunView => {
    const id = nextId("run");
    const created = run(id, "queued", {
      machineId: "mac-studio",
      queueReason: "machine_full",
      createdAt: Date.now(),
      ...fields,
    });
    record(task.id, entry("run_queued", SYSTEM, Date.now(), { runId: id }));
    return created;
  };

  const stopRuns = (task: BoardTaskDetail, why: string): BoardTaskDetail => {
    const runs = task.runs.map((item) => {
      if (!active(item.status)) return item;
      record(
        task.id,
        entry("run_interrupted", SYSTEM, Date.now(), {
          runId: item.id,
          body: why,
        }),
      );
      return {
        ...item,
        status: "interrupted" as const,
        finishedAt: Date.now(),
      };
    });
    return withRuns(task, runs);
  };

  host.on("tasks.update", (args: TaskArgs["update"]): TaskResults["update"] => {
    if (
      scenario === "pr-states" &&
      args.status === "done" &&
      !completionFailed
    ) {
      completionFailed = true;
      throw new Error("Host did not respond in time.");
    }
    const before = read(args.taskId);
    let task = before;
    if (args.title !== undefined) {
      const title = args.title.trim();
      if (title === "") throw new Error("a task needs a title");
      record(
        task.id,
        entry("title", USER, Date.now(), {
          data: { from: task.title, to: title },
        }),
      );
      task = { ...task, title };
    }
    if (args.description !== undefined) {
      record(task.id, entry("description", USER, Date.now()));
      task = { ...task, description: args.description };
    }
    if (args.status !== undefined && args.status !== task.status) {
      record(
        task.id,
        entry("status", USER, Date.now(), {
          data: { from: task.status, to: args.status },
        }),
      );
      task = { ...task, status: args.status };
      if (task.status === "done" || task.status === "cancelled")
        task = stopRuns(task, `The task is ${task.status}.`);
      else if (
        workable(task.status) &&
        !workable(before.status) &&
        task.runs.length === 0
      )
        task = withRuns(task, [startRun(task)]);
    }
    return { task: write(task) };
  });

  const failures = { comment: scenario === "comment-fails" };
  let completionFailed = false;
  const delivered = new Set<string>();

  host.on(
    "tasks.comment",
    async (args: TaskArgs["comment"]): Promise<TaskResults["comment"]> => {
      await new Promise((done) => setTimeout(done, 150));
      if (failures.comment) {
        failures.comment = false;
        throw new Error("Network connection failed.");
      }
      let task = read(args.taskId);
      const body = args.body;
      if (body.trim() === "") throw new Error("a comment needs some text");
      if (args.clientId !== undefined && delivered.has(args.clientId)) {
        const earlier = activity(task.id).find(
          (a) => a.data.clientId === args.clientId,
        );
        if (earlier !== undefined) return { task, activity: earlier };
      }
      if (args.clientId !== undefined) delivered.add(args.clientId);
      const mentions = [...new Set(args.mentions ?? [])];
      const added = entry("comment", USER, Date.now(), {
        body,
        data: {
          ...(args.clientId === undefined ? {} : { clientId: args.clientId }),
          ...(mentions.length === 0 ? {} : { mentions }),
        },
      });
      record(task.id, added);
      task = { ...task, comments: task.comments + 1 };
      // A run that is going reads it; with none, it wakes the executor in the same session.
      const executorId = task.assigneeAgentId ?? task.createdBy.agentId;
      const others = mentions.filter((id) => id !== executorId);
      const wakesExecutor =
        mentions.length === 0 || mentions.includes(executorId ?? "");
      const runs = [...task.runs];
      for (const agentId of others) runs.push(startRun(task, { agentId }));
      const going = task.runs.some(
        (item) => item.agentId === null && active(item.status),
      );
      if (
        wakesExecutor &&
        !going &&
        workable(task.status) &&
        task.runs.length > 0
      ) {
        const last = task.runs.filter((item) => item.agentId === null).at(-1);
        runs.push(
          startRun(task, {
            continuesRunId: last?.id ?? null,
            sessionId: last?.sessionId ?? null,
            machineId: last?.machineId ?? "mac-studio",
          }),
        );
      }
      return { task: write(withRuns(task, runs)), activity: added };
    },
  );

  host.on("tasks.delete", (args: TaskArgs["delete"]): TaskResults["delete"] => {
    const task = read(args.taskId);
    if (task.runs.some((item) => active(item.status)))
      throw new Error("a run is working on this task; stop it before deleting");
    host.state.delete(target(task.id));
    host.patch(
      "tasks",
      "list",
      list().filter((other) => other.id !== task.id),
    );
    host.event(target(task.id), "target:missing", null);
    return { taskId: task.id };
  });

  host.on("tasks.link", (args: TaskArgs["link"]): TaskResults["link"] => {
    const task = read(args.taskId);
    record(
      task.id,
      entry("conversation", USER, Date.now(), {
        data: { from: task.conversationId, to: args.conversationId },
      }),
    );
    return { task: write({ ...task, conversationId: args.conversationId }) };
  });

  host.on(
    "tasks.interrupt",
    (args: TaskArgs["interrupt"]): TaskResults["interrupt"] => {
      const task = read(args.taskId);
      const target = task.runs.find((item) => item.id === args.runId);
      if (target === undefined) throw new Error(`no such run: ${args.runId}`);
      if (!active(target.status)) throw new Error("this run has already ended");
      const runs = task.runs.map((item) =>
        item.id === args.runId
          ? { ...item, status: "interrupted" as const, finishedAt: Date.now() }
          : item,
      );
      record(
        task.id,
        entry("run_interrupted", USER, Date.now(), { runId: args.runId }),
      );
      return { task: write(withRuns(task, runs)) };
    },
  );

  host.on("tasks.rerun", (args: TaskArgs["rerun"]): TaskResults["rerun"] => {
    const task = read(args.taskId);
    if (task.runs.some((item) => item.agentId === null && active(item.status)))
      throw new Error("this task already has a run that has not ended");
    const created = startRun(task);
    return {
      task: write(withRuns(task, [...task.runs, created])),
      run: created,
    };
  });

  // A `task_draft` row becomes the task, and the row its card. The same row confirmed again is
  // the same task.
  const confirmed = new Map<string, string>();
  host.on(
    "tasks.confirmDraft",
    (args: TaskArgs["confirmDraft"]): TaskResults["confirmDraft"] => {
      const target_ = `conversations.${args.conversationId}`;
      const timeline = host.section<{
        messages: { id: string; data: unknown }[];
      }>(target_, "timeline");
      const row = timeline?.messages.find(
        (message) => message.id === args.messageId,
      );
      if (row === undefined)
        throw new Error(`no such draft: ${args.messageId}`);
      const known = confirmed.get(args.messageId);
      if (known !== undefined)
        return {
          task: read(known),
          message: row as TaskResults["confirmDraft"]["message"],
        };
      const draft = row.data as TaskDraftData;
      const number = Math.max(...list().map((task) => task.number)) + 1;
      const id = `task-${number}`;
      const status = args.edits?.status ?? "todo";
      const made = detail({
        id,
        number,
        title: args.edits?.title ?? draft.title,
        status,
        by: agent("ache"),
        conversationId: args.conversationId,
        updatedAt: Date.now(),
        description: args.edits?.description ?? draft.description,
        activity: [
          entry("created", agent("ache"), Date.now(), { data: { status } }),
        ],
      });
      host.set(target(id), made);
      const task = workable(status)
        ? withRuns(made.task, [startRun(made.task)])
        : made.task;
      confirmed.set(args.messageId, id);
      const card = {
        ...row,
        kind: "task_card",
        data: {
          taskId: id,
          number,
          title: task.title,
          status: task.status,
          runStatus: task.runStatus,
          conversationId: args.conversationId,
          comments: 0,
          summary: "",
          artifacts: [],
          ...(draft.turnMessageId === undefined
            ? {}
            : { turnMessageId: draft.turnMessageId }),
        },
      };
      host.patch(target_, "timeline", {
        ...timeline,
        messages: timeline?.messages.map((message) =>
          message.id === args.messageId ? card : message,
        ),
      });
      return {
        task: write(task),
        message: card as unknown as TaskResults["confirmDraft"]["message"],
      };
    },
  );
}

const BOARD_SCENARIOS = [
  "",
  "no-github",
  "pr-states",
  "comment-fails",
  "task-gone",
  "task-loading",
];

export function installTasks(host: FakeHost): void {
  installGithub(host);
  installBoard(host);
  host.set(`sessions.${replay.sessionId}`, {
    core: { session: replay.sessionId, running: false },
    transcript: { messages: replayLog() },
  });
  const scenario = host.scenario;
  // Queued behind the inbox fixture's, which puts 01's tasks on any board it finds without them.
  if (scenario === "empty")
    void Promise.resolve().then(() => host.patch("tasks", "list", []));
  // The other scenarios are other fixtures': they keep the board they laid out.
  if (!BOARD_SCENARIOS.includes(scenario)) return;
  const details = [...FEATURED, ...filler()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(detail);
  host.set(
    "tasks",
    {
      list: details.map(({ task }) => {
        const {
          description: _description,
          artifacts: _artifacts,
          projectId: _projectId,
          workspace: _workspace,
          originConversationId: _origin,
          runs: _runs,
          ...view
        } = task;
        return view;
      }),
    },
    { eager: true },
  );
  for (const sections of details) {
    if (sections.task.number === 135 && scenario === "task-gone") continue;
    if (sections.task.number === 135 && scenario === "task-loading") {
      host.set(`tasks.${sections.task.id}`, {});
      continue;
    }
    host.set(`tasks.${sections.task.id}`, sections);
  }
}
