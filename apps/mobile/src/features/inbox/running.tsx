// What is running, for 01a and 10a. A run is a member answering in a conversation or a run of a
// board task. The board says only that a task is running: which machine and session it is on are
// in `tasks.<id>`, and what a run is doing right now only in its session's view.

import type {
  BoardTaskDetail,
  BoardTaskView,
  ConversationSummary,
  MemberView,
  SessionViewSections,
  TaskRunView,
  ViewMessageRow,
} from "@eta/client-contracts";
import { cleanup, computed, effect, Text, View } from "nsh";
import { agentById, boardTasks, conversations, machineById, projectById } from "../../app/lists";
import { wire } from "../../app/session";
import { t } from "../../i18n";
import { go } from "../../nav/links";
import { AgentAvatar } from "../../ui/AgentAvatar";
import { Icon } from "../../ui/Icon";

export interface Run {
  key: string;
  agentId: string | null;
  title: string;
  /** Null until the run has a session. */
  sessionId: string | null;
  machineId: string | null;
  /** A run of a board task, which `maxActiveRuns` limits; a conversation's reply is not one. */
  task: boolean;
  /** When it started, where the host says so; a member's comes from its session. */
  since?: number;
  open: () => void;
}

const ACTIVE = new Set<string | null>(["starting", "running"]);

/** Who works on a task. */
export const executorOf = (task: BoardTaskView): string | null =>
  task.assigneeAgentId ?? task.createdBy.agentId;

const members = (status: MemberView["status"]) =>
  conversations().flatMap((conversation) =>
    conversation.participants
      .filter((member) => member.status === status)
      .map((member) => ({ conversation, member })),
  );

/** How many runs go on and how many wait, from what the lists carry: the gauges need no target. */
export function runCounts(): { running: number; queued: number } {
  const tasks = boardTasks();
  return {
    running: members("working").length + tasks.filter((task) => ACTIVE.has(task.runStatus)).length,
    queued:
      members("queued").length + tasks.filter((task) => task.runStatus === "queued").length,
  };
}

const memberRun = (conversation: ConversationSummary, member: MemberView): Run => {
  const agent = agentById(member.agentId);
  const where = conversation.kind === "direct" ? t("inbox.direct") : conversation.name;
  return {
    key: `member:${conversation.id}:${member.agentId}`,
    agentId: member.agentId,
    title: `${agent?.name ?? member.agentId} · ${where}`,
    sessionId: member.sessionId,
    machineId: agent?.machineId ?? projectById(conversation.projectId)?.machineId ?? null,
    task: false,
    open: () => go.chat(conversation.id),
  };
};

const taskRun = (task: BoardTaskView, run: TaskRunView): Run => {
  const agentId = run.agentId ?? executorOf(task);
  const who = agentById(agentId)?.name;
  return {
    key: `task:${run.id}`,
    agentId,
    title: `${who === undefined ? "" : `${who} · `}#${task.number} ${task.title}`,
    sessionId: run.sessionId,
    machineId: run.machineId,
    task: true,
    since: run.startedAt ?? run.createdAt,
    open: () => go.task(task.id),
  };
};

/**
 * Every run with what is known of it, kept live for as long as the calling component lives: the
 * tasks that have a run going or queued are subscribed to as they come and go.
 */
export function useRuns() {
  const connection = wire();
  const held = new Map<string, () => void>();
  const unfinished = () =>
    boardTasks().filter((task) => ACTIVE.has(task.runStatus) || task.runStatus === "queued");
  effect(() => {
    const ids = new Set(unfinished().map((task) => task.id));
    for (const id of ids) {
      if (!held.has(id)) held.set(id, connection.subscribe(`tasks.${id}`));
    }
    for (const [id, release] of held) {
      if (ids.has(id)) continue;
      release();
      held.delete(id);
    }
  });
  cleanup(() => {
    for (const release of held.values()) release();
  });
  const taskRuns = () =>
    unfinished().flatMap((task) =>
      (connection.section<BoardTaskDetail>(`tasks.${task.id}`, "task")?.runs ?? []).map((run) => ({
        task,
        run,
      })),
    );
  /** When it started; a member's is known once its row has opened the session. */
  const startedAt = (run: Run): number => {
    if (run.since !== undefined) return run.since;
    if (run.sessionId === null) return Number.MAX_SAFE_INTEGER;
    const transcript = connection.section<SessionViewSections["transcript"]>(
      `sessions.${run.sessionId}`,
      "transcript",
    );
    return (
      transcript?.messages.findLast((row) => row.message.role === "user")?.at ??
      Number.MAX_SAFE_INTEGER
    );
  };
  return {
    /** The longest running first. */
    running: (): Run[] =>
      [
        ...members("working").map(({ conversation, member }) => memberRun(conversation, member)),
        ...taskRuns()
          .filter(({ run }) => ACTIVE.has(run.status))
          .map(({ task, run }) => taskRun(task, run)),
      ].toSorted((a, b) => startedAt(a) - startedAt(b)),
    /** The runs waiting for a slot or for their machine to come back. */
    queued: (): TaskRunView[] =>
      taskRuns()
        .map(({ run }) => run)
        .filter((run) => run.status === "queued"),
  };
}

/** A session's view, opened first: a session is only a target while it is open. */
function useSession(run: () => string | null) {
  const connection = wire();
  // A list push makes a new run: only another session is a reason to open one.
  const id = computed(run);
  effect(() => {
    const session = id();
    if (session === null) return;
    let release: (() => void) | undefined;
    let gone = false;
    void connection
      .call("sessions", "resync", { session })
      .catch(() => undefined)
      .then(() => {
        if (!gone) release = connection.subscribe(`sessions.${session}`);
      });
    cleanup(() => {
      gone = true;
      release?.();
    });
  });
  return <K extends "core" | "transcript">(section: K) => {
    const session = id();
    return session === null
      ? undefined
      : connection.section<SessionViewSections[K]>(`sessions.${session}`, section);
  };
}

const baseName = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path;

function describeTool(name: string, args: Record<string, unknown>): string {
  const text = (...keys: string[]): string | undefined => {
    const value = keys.map((key) => args[key]).find((item) => typeof item === "string");
    return value as string | undefined;
  };
  const path = text("file_path", "path");
  const tool = name.toLowerCase();
  if (tool === "bash") {
    const command = text("command", "cmd")?.split("\n")[0];
    if (command !== undefined) return t("inbox.run.bash", { what: command });
  }
  if (tool === "read" && path !== undefined) return t("inbox.run.read", { what: baseName(path) });
  if ((tool === "edit" || tool === "write") && path !== undefined)
    return t("inbox.run.edit", { what: baseName(path) });
  return t("inbox.run.tool", { what: name });
}

interface Progress {
  doing?: string;
  since?: number;
}

/** The tool call with no result yet, newest first, or thinking; since the run's last prompt. */
export function progressOf(messages: ViewMessageRow[], streaming?: unknown): Progress {
  const rows = messages.map((row) => row.message as unknown as RawMessage);
  if (streaming !== undefined) rows.push(streaming as RawMessage);
  const finished = new Set(
    rows.flatMap((row) => (row.role === "toolResult" ? [row.toolCallId] : [])),
  );
  const started = messages.findLast((row) => row.message.role === "user")?.at;
  for (const row of rows.toReversed()) {
    if (row.role === "user") break;
    if (row.role !== "assistant") continue;
    const content = Array.isArray(row.content) ? row.content : [];
    const open = content.findLast((block) => block.type === "toolCall" && !finished.has(block.id));
    if (open !== undefined) {
      return {
        doing: describeTool(open.name ?? "", open.arguments ?? {}),
        ...(started === undefined ? {} : { since: started }),
      };
    }
  }
  return {
    doing: t("inbox.run.thinking"),
    ...(started === undefined ? {} : { since: started }),
  };
}

interface RawMessage {
  role: string;
  toolCallId?: string;
  content?: { type: string; id?: string; name?: string; arguments?: Record<string, unknown> }[];
}

/** `30 秒`, `8 分钟`, `2 小时`. */
function elapsed(since: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
  if (seconds < 60) return t("inbox.run.seconds", { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("common.minutesAgo", { count: minutes });
  return t("common.hoursAgo", { count: Math.floor(minutes / 60) });
}

/**
 * A run's row. 01a says what it is doing, and where if that is not the host itself. 10a is on one
 * machine already, and says only that it works and for how long (`plain`).
 */
export function RunRow(props: { run: Run; plain?: boolean; last?: boolean }) {
  const session = useSession(() => props.run.sessionId);
  const progress = (): Progress | undefined => {
    const core = session("core");
    const transcript = session("transcript");
    return core === undefined && transcript === undefined
      ? undefined
      : progressOf(transcript?.messages ?? [], core?.streaming);
  };
  const line = () => {
    const known = progress();
    const machine = machineById(props.run.machineId);
    const since = props.run.since ?? known?.since;
    return [
      !props.plain && machine !== undefined && machine.kind !== "primary" ? machine.name : undefined,
      props.plain ? t("inbox.run.working") : (known?.doing ?? t("inbox.run.working")),
      since === undefined ? undefined : elapsed(since),
    ]
      .filter((part) => part !== undefined)
      .join(" · ");
  };
  return (
    <View
      role="button"
      accessibilityLabel={props.run.title}
      onPress={() => props.run.open()}
      class={`h-[56px] shrink-0 flex-row items-center gap-[10px] border-t px-4 active:bg-muted border-border ${props.last ? "border-b" : ""}`}
    >
      <If when={!props.plain && props.run.agentId !== null}>
        <AgentAvatar id={props.run.agentId ?? ""} size={20} />
      </If>
      <View class="min-w-0 grow basis-0">
        <Text class="truncate text-base leading-[20px] text-foreground">{props.run.title}</Text>
        <Text class="truncate text-sm leading-4 text-muted-foreground">{line()}</Text>
      </View>
      <Icon name="caretRight" size={14} color="faint" />
    </View>
  );
}
