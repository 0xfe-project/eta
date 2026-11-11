// Design 01: three questions, three tasks. Scenarios: `answered` (01a: nothing waits, four runs),
// `multi` (01b), `many` (more answers than a row holds), `machines` (10b: five runs and one queued, across the machines).

import type {
  AgentMessage,
  BoardTaskDetail,
  BoardTaskView,
  ConversationSummary,
  InboxResponse,
  InteractionView,
  ProjectView,
  TaskRunStatus,
  TaskRunView,
} from "@eta/client-contracts";
import type { FakeHost } from "../fake-host";
import { CONVERSATIONS, minutesAgo, PROJECTS } from "./base";

const today = (hour: number, minute: number) =>
  new Date().setHours(hour, minute, 0, 0);

const ask = (
  id: string,
  agentId: string,
  conversationId: string,
  createdAt: number,
  prompt: string,
  options: string[] = [],
  multi = false,
): InteractionView => ({
  id,
  sessionId: `session-${agentId}`,
  questionId: `call-${id}`,
  agentId,
  conversationId,
  replyId: null,
  prompt,
  options,
  multi,
  status: "pending",
  answer: null,
  revision: 1,
  createdAt,
  updatedAt: createdAt,
});

/** Newest first, as the host lists them. */
const QUESTIONS: InteractionView[] = [
  ask("q-weekly", "agent-xiaoman", "dm-xiaoman", today(9, 40), "Who gets the weekly report?"),
  ask(
    "q-push",
    "agent-mori",
    "redesign",
    today(9, 38),
    "Want to push the branch to the remote\ngit push origin redesign --force-with-lease",
    ["allow", "deny"],
  ),
  ask(
    "q-migrate",
    "agent-ache",
    "wire",
    today(9, 29),
    "Should the migration script run directly on the production database?",
    ["Back up first, then run", "Run it directly", "Don't run it yet"],
  ),
];

const MULTI: InteractionView[] = [
  ask(
    "q-release",
    "agent-ache",
    "wire",
    today(9, 29),
    "Which changes should this release include? Multiple choice.",
    ["Reconnect frame catch-up", "Migration script", "Log noise reduction"],
    true,
  ),
];

const MANY: InteractionView[] = [
  ask("q-window", "agent-ache", "wire", today(9, 29), "When should the migration run?", [
    "Now",
    "Tonight",
    "This weekend",
    "Next week",
  ]),
];

const task = (
  number: number,
  title: string,
  status: BoardTaskView["status"],
  agentId: string,
  runStatus: TaskRunStatus | null,
): BoardTaskView => ({
  id: `task-${number}`,
  number,
  title,
  status,
  createdBy: { kind: "agent", agentId },
  assigneeAgentId: null,
  conversationId: null,
  runStatus,
  comments: 0,
  createdAt: minutesAgo(600),
  updatedAt: minutesAgo(30),
});

const ATTENTION: BoardTaskView[] = [
  task(128, "Resend lost frames after reconnect", "in_review", "agent-ache", "completed"),
  task(41, "Swap homepage first screen to new copy", "in_review", "agent-mori", "completed"),
  task(129, "Archive backup to nas", "blocked", "agent-ache", "completed"),
];

function setRun(
  host: FakeHost,
  row: BoardTaskView,
  status: TaskRunStatus,
  machineId: string,
  fields: Partial<TaskRunView> = {},
): void {
  const run: TaskRunView = {
    id: `run-${row.number}`,
    agentId: null,
    status,
    queueReason: null,
    machineId,
    sessionId: null,
    continuesRunId: null,
    workspace: null,
    nudged: false,
    error: null,
    createdAt: minutesAgo(10),
    startedAt: status === "queued" ? null : minutesAgo(10),
    finishedAt: null,
    ...fields,
  };
  const detail: BoardTaskDetail = {
    ...row,
    description: "",
    artifacts: [],
    projectId: "eta",
    workspace: { mode: "worktree", base: null, path: null, branch: null },
    originConversationId: null,
    runs: [run],
  };
  host.set(`tasks.${row.id}`, { task: detail, activity: [] });
}

const member = (
  agentId: string,
  status: "idle" | "working",
  sessionId: string,
) => ({
  agentId,
  sessionId,
  lastSeq: 10,
  status,
});

function setSession(
  host: FakeHost,
  id: string,
  startedMinutesAgo: number,
  call?: { name: string; arguments: Record<string, string> },
): void {
  const row = (entryId: string, seq: number, at: number, message: unknown) => ({
    entryId,
    seq,
    at,
    message: message as AgentMessage,
  });
  const at = minutesAgo(startedMinutesAgo);
  host.set(`sessions.${id}`, {
    core: { session: id, running: true },
    transcript: {
      messages: [
        row("e1", 1, at, { role: "user", content: "Continue", timestamp: at }),
        ...(call === undefined
          ? []
          : [
              row("e2", 2, at, {
                role: "assistant",
                content: [{ type: "toolCall", id: "c1", ...call }],
                timestamp: at,
              }),
            ]),
      ],
    },
  });
}

/** 01a. Each run has a session of its own here, so each row says something of its own. */
function installAnswered(host: FakeHost): void {
  const conversations: ConversationSummary[] = CONVERSATIONS.map((row) => {
    if (row.id === "board")
      return {
        ...row,
        participants: [member("agent-mori", "working", "s-board")],
      };
    if (row.id === "wire")
      return {
        ...row,
        participants: [member("agent-ache", "working", "s-wire")],
      };
    if (row.id === "redesign")
      return {
        ...row,
        participants: [member("agent-mori", "working", "s-redesign")],
      };
    return {
      ...row,
      participants: row.participants.map((one) => ({
        ...one,
        status: "idle" as const,
      })),
    };
  });
  host.patch("conversations", "list", conversations);
  const projects: ProjectView[] = PROJECTS.map((row) =>
    row.id === "site" ? { ...row, machineId: "gpu-box" } : row,
  );
  host.patch("projects", "list", projects);
  setSession(host, "s-board", 8, {
    name: "Edit",
    arguments: { file_path: "src/task-board.tsx" },
  });
  setSession(host, "s-wire", 2, {
    name: "bash",
    arguments: { command: "bun test wire" },
  });
  setSession(host, "s-redesign", 0.5, {
    name: "Read",
    arguments: { file_path: "src/hero.tsx" },
  });
  const row = task(
    133,
    "Run history supports pagination",
    "in_progress",
    "agent-xiaoman",
    "running",
  );
  host.patch("tasks", "list", [row]);
  setRun(host, row, "running", "mac-studio", {
    sessionId: "s-133",
    startedAt: minutesAgo(1),
  });
  setSession(host, "s-133", 1);
}

/** 10b's load: 3/4, 1/2, 1/4, and a task waiting for nas to come back. */
function installLoad(host: FakeHost): void {
  const runs: [number, string, string][] = [
    [201, "Run history supports pagination", "mac-studio"],
    [202, "wire frame backfill test", "mac-studio"],
    [203, "Board sorting", "mac-studio"],
    [204, "Website redesign", "mb-air"],
    [205, "Batch transcoding", "gpu-box"],
  ];
  const rows = runs.map(([number, title, machineId]) => {
    const row = task(number, title, "in_progress", "agent-mori", "running");
    setRun(host, row, "running", machineId);
    return row;
  });
  const waiting = task(206, "Archive backup to nas", "todo", "agent-ache", "queued");
  setRun(host, waiting, "queued", "nas", { queueReason: "machine_offline" });
  host.patch("tasks", "list", [...rows, waiting]);
}

/** 01b has the question alone on the page. */
function clearAttention(host: FakeHost): void {
  const board = host.section<BoardTaskView[]>("tasks", "list") ?? [];
  host.patch(
    "tasks",
    "list",
    board.filter(
      (row) => row.status !== "in_review" && row.status !== "blocked",
    ),
  );
}

/** The board is the tasks fixture's; what 01 needs of it goes in if that left it out. */
function ensureAttention(host: FakeHost): void {
  const board = host.section<BoardTaskView[]>("tasks", "list") ?? [];
  const missing = ATTENTION.filter(
    (row) => !board.some((one) => one.number === row.number),
  );
  host.patch("tasks", "list", [...board, ...missing]);
}

export function installInbox(host: FakeHost): void {
  const questions = () => {
    if (host.scenario === "multi") return MULTI;
    if (host.scenario === "many") return MANY;
    if (host.scenario === "answered" || host.scenario === "uninitialized")
      return [];
    return QUESTIONS;
  };
  host.patch("inbox", "list", questions());

  // As `inbox.answer`: a settled row stays in the list, behind the pending ones, and the run goes on.
  host.on(
    "inbox.answer",
    ({ id, response }: { id: string; response: InboxResponse }) => {
      const list = host.section<InteractionView[]>("inbox", "list");
      const row = list.find((one) => one.id === id);
      if (row === undefined) throw new Error(`no such question: ${id}`);
      if (row.status !== "pending")
        return { interaction: row, answered: false };
      const settled: InteractionView = {
        ...row,
        status: response.kind === "none" ? "canceled" : "answered",
        answer: response,
        revision: row.revision + 1,
        updatedAt: Date.now(),
      };
      host.patch("inbox", "list", [
        ...list.filter((one) => one.status === "pending" && one.id !== id),
        settled,
        ...list.filter((one) => one.status !== "pending"),
      ]);
      const conversations = host.section<ConversationSummary[]>(
        "conversations",
        "list",
      );
      host.patch(
        "conversations",
        "list",
        conversations.map((one) =>
          one.id === row.conversationId
            ? {
                ...one,
                participants: one.participants.map((person) =>
                  person.agentId === row.agentId &&
                  person.status === "waiting_for_input"
                    ? {
                        ...person,
                        status: response.kind === "none" ? "idle" : "working",
                      }
                    : person,
                ),
              }
            : one,
        ),
      );
      return { interaction: settled, answered: true };
    },
  );
  host.on("sessions.resync", () => ({}));

  // After every fixture has run, the tasks one included, and before `hello` goes out.
  void Promise.resolve().then(() => {
    if (host.scenario === "answered") installAnswered(host);
    else if (host.scenario === "machines") installLoad(host);
    else if (host.scenario === "multi" || host.scenario === "many")
      clearAttention(host);
    else if (host.scenario !== "uninitialized") ensureAttention(host);
  });
}
