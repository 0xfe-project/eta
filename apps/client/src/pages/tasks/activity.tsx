import type {
  BoardTaskStatus,
  TaskActivityView,
  TaskActor,
  TaskRunView,
} from "@eta/client-contracts";
import { dependencyEntry, subtaskEntry } from "@eta/client-contracts";
import { signal, View } from "nsh";
import { Caption, Icon, Label, Markdown, row } from "../../components";
import { AgentFace, UserFace } from "../../components/agent-face";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { taskMoment } from "./facts";
import { isActiveRunStatus } from "./run-log";
import { statusKeys, statusName } from "./status";

/** The kinds said the same way whatever their data. */
const activityKeys: Partial<
  Record<TaskActivityView["kind"], Parameters<typeof uiText>[0]>
> = {
  description: "activityDescription",
  run_queued: "activityRunQueued",
  run_started: "activityStartedWork",
  run_completed: "activityRunCompleted",
  run_failed: "activityRunFailed",
  run_interrupted: "activityRunInterrupted",
  run_nudged: "activityRunNudged",
  archived: "activityArchived",
  unarchived: "activityUnarchived",
};

/** A stopped or failed turn says why in its sentence, one line, not under it. */
function inlineBody(entry: TaskActivityView) {
  return (
    (entry.kind === "run_interrupted" || entry.kind === "run_failed") &&
    !!entry.body?.trim()
  );
}

/** What an entry says on a desktop task page: a sentence, the task at the other end quoted. */
function taskActivitySentence(entry: TaskActivityView): string {
  if (inlineBody(entry))
    return uiText(
      entry.kind === "run_failed"
        ? "activityTurnFailed"
        : "activityTurnStopped",
      { reason: entry.body!.trim().replace(/\s+/g, " ") },
    );
  if (entry.kind === "status") {
    const from = entry.data.from as BoardTaskStatus;
    const to = entry.data.to as BoardTaskStatus;
    if (Object.hasOwn(statusKeys, from) && Object.hasOwn(statusKeys, to))
      return uiText("activityStatus", {
        from: statusName(from),
        to: statusName(to),
      });
  }
  if (entry.kind === "dependency") {
    const edge = dependencyEntry(entry.data);
    if (edge) {
      const title = edge.title || `#${edge.number}`;
      if (edge.action === "added")
        return uiText("activityPrerequisiteAdded", { title });
      if (edge.action === "removed" || edge.action === "deleted")
        return uiText("activityPrerequisiteRemoved", { title });
      if (edge.action === "blocked")
        return uiText("activityBlocked", { title });
      if (edge.action === "unblocked") return uiText("activityUnblocked");
    }
  }
  if (entry.kind === "parent") {
    const to = entry.data.to as { title?: string } | null;
    const from = entry.data.from as { title?: string } | null;
    if (to?.title) return uiText("activityParent", { title: to.title });
    if (from?.title)
      return uiText("activityParentRemoved", { title: from.title });
  }
  if (entry.kind === "subtask") {
    const subtask = subtaskEntry(entry.data);
    if (subtask?.action === "all_cancelled")
      return uiText("activitySubtasksCancelled");
    if (subtask)
      return uiText(
        subtask.action === "added"
          ? "activitySubtaskAdded"
          : "activitySubtaskRemoved",
        { title: subtask.task.title || `#${subtask.task.number}` },
      );
  }
  if (entry.kind === "title" && typeof entry.data.to === "string")
    return uiText("activityRenamed", { title: entry.data.to });
  if (entry.kind === "artifact" && typeof entry.data.title === "string")
    return uiText("activityArtifact", { title: entry.data.title });
  if (entry.kind === "conversation")
    return uiText(
      entry.data.to ? "activityConversation" : "activityConversationRemoved",
    );
  if (entry.kind === "created") return uiText("activityCreated");
  if (entry.kind === "comment") return uiText("activityCommented");
  return uiText(activityKeys[entry.kind] ?? "activityChanged");
}

// --- the thread -------------------------------------------------------------------------
//
// A task's history reads as a thread, as on the web (apps/web `Timeline`): what was said is a
// message under its sender's face, open; what was delivered, what failed and what happened to a
// dependency each keep a line of their own; everything else between two of those folds into one
// "N updates" line, closed until pressed. Nothing is said twice: the first message (the
// description) already says who made the task, and a run still going is said under the thread.

/** What the thread gives a line of its own: what was said, what was delivered, what went wrong. */
const standalone = new Set<TaskActivityView["kind"]>([
  "comment",
  "artifact",
  "run_failed",
  "dependency",
]);

/** Never a line: the description already says who made the task, and a queued run is said below. */
const unlisted = new Set<TaskActivityView["kind"]>(["created", "run_queued"]);

/** A sender's comments run together under one face while they follow each other within this. */
const runOn = 5 * 60_000;

/** How long a comment shows before "Expand full text". */
const commentPreview = 600;

type ThreadItem =
  | { kind: "message"; entry: TaskActivityView; head: boolean }
  | { kind: "line"; entry: TaskActivityView }
  | { kind: "updates"; entries: TaskActivityView[] };

const sameActor = (a: TaskActor, b: TaskActor) =>
  a.kind === b.kind && (a.agentId ?? null) === (b.agentId ?? null);

/** The entries of a task's timeline as the thread lays them out, oldest first. */
function taskThread(
  entries: TaskActivityView[],
  runs: TaskRunView[],
): ThreadItem[] {
  const going = new Set(
    runs.filter((run) => isActiveRunStatus(run.status)).map((run) => run.id),
  );
  const out: ThreadItem[] = [];
  for (const entry of entries) {
    if (unlisted.has(entry.kind)) continue;
    if (entry.kind === "run_started" && entry.runId && going.has(entry.runId))
      continue;
    const last = out.at(-1);
    if (entry.kind === "comment") {
      const head = !(
        last?.kind === "message" &&
        sameActor(last.entry.actor, entry.actor) &&
        entry.createdAt - last.entry.createdAt < runOn
      );
      out.push({ kind: "message", entry, head });
    } else if (standalone.has(entry.kind)) out.push({ kind: "line", entry });
    else if (last?.kind === "updates") last.entries.push(entry);
    else out.push({ kind: "updates", entries: [entry] });
  }
  return out;
}

/** A dependency line's mark: linked, unlinked, broken, or back. */
function dependencyIcon(entry: TaskActivityView) {
  const edge = dependencyEntry(entry.data);
  if (!edge) return undefined;
  if (edge.action === "blocked")
    return { name: "warning" as const, tone: "red" as const };
  if (edge.action === "unblocked")
    return { name: "refresh" as const, tone: "muted" as const };
  if (edge.action === "removed" || edge.action === "deleted")
    return { name: "linkBreak" as const, tone: "muted" as const };
  return { name: "link" as const, tone: "muted" as const };
}

export function TaskActivity(props: {
  entries: TaskActivityView[];
  runs: TaskRunView[];
  /** Who a run's events read as when the host wrote them: the task's maker, as on the web. */
  createdBy: TaskActor;
  /** The heading over the thread; the chat panel has its own "N replies" rule instead. */
  heading?: "desktop" | "tablet" | "phone";
  /** The space between a face and its text; a line's text starts at 20 + this. */
  gap?: number;
  onLog?: (run: TaskRunView) => void;
}) {
  const host = useHost();
  const gap = () => props.gap ?? 8;
  const indent = () => 20 + gap();
  const name = (actor: TaskActor) =>
    host.agent(actor.agentId)?.name ??
    (actor.kind === "user" ? uiText("taskMe") : "Eta");
  const lineActor = (entry: TaskActivityView) =>
    entry.kind.startsWith("run_") && entry.actor.kind !== "agent"
      ? props.createdBy
      : entry.actor;
  const runOf = (entry: TaskActivityView) =>
    entry.runId ? props.runs.find((run) => run.id === entry.runId) : undefined;
  const items = () => taskThread(props.entries, props.runs);
  const Line = (line: { entry: TaskActivityView }) => {
    const mark = () =>
      line.entry.kind === "dependency"
        ? dependencyIcon(line.entry)
        : line.entry.kind === "artifact"
          ? { name: "appWindow" as const, tone: "muted" as const }
          : undefined;
    const run = () => runOf(line.entry);
    return (
      <View style={{ ...row, gap: 4, flexWrap: "wrap" }}>
        <Label variant="caption" tone="muted">
          {name(lineActor(line.entry))}
        </Label>
        <If when={mark()}>
          {(icon) => <Icon name={icon().name} size={10} tone={icon().tone} />}
        </If>
        <Label
          variant="caption"
          tone={line.entry.kind === "run_failed" ? "red" : "muted"}
        >
          {taskActivitySentence(line.entry)}
        </Label>
        <Label variant="caption" tone="muted">
          {taskMoment(line.entry.createdAt)}
        </Label>
        <If when={props.onLog && run()}>
          {(item) => (
            <View
              role="button"
              accessibilityLabel={uiText("executionLog")}
              onPress={() => props.onLog?.(item())}
              style={{ cursor: "pointer" }}
            >
              <Label variant="caption">{uiText("executionLog")}</Label>
            </View>
          )}
        </If>
      </View>
    );
  };
  const Updates = (fold: { entries: TaskActivityView[] }) => {
    const open = signal(false);
    const label = () =>
      uiText(fold.entries.length === 1 ? "oneTaskUpdate" : "taskUpdates", {
        count: fold.entries.length,
      });
    return (
      <View style={{ gap: 4, paddingTop: 6, paddingLeft: indent() }}>
        <View
          role="button"
          accessibilityLabel={label()}
          accessibilityState={{ expanded: open() }}
          onPress={() => open.set(!open())}
          style={{ ...row, gap: 4, alignSelf: "flex-start", cursor: "pointer" }}
        >
          <Icon
            name={open() ? "down" : "right"}
            size={10}
            tone={open() ? "ink" : "muted"}
          />
          <Label variant="caption" tone={open() ? "ink" : "muted"}>
            {label()}
          </Label>
        </View>
        <If when={open()}>
          <Each of={fold.entries} key={(entry) => entry.id}>
            {(entry) => <Line entry={entry()} />}
          </Each>
        </If>
      </View>
    );
  };
  const Message = (message: { entry: TaskActivityView; head: boolean }) => {
    const full = signal(false);
    const body = () => message.entry.body ?? "";
    const long = () => body().length > commentPreview;
    return (
      <View
        style={{
          ...row,
          alignItems: "flex-start",
          gap: gap(),
          paddingTop: message.head ? 12 : 4,
        }}
      >
        <View style={{ width: 20, flexShrink: 0 }}>
          <If when={message.head}>
            <If
              when={message.entry.actor.kind === "agent"}
              else={<UserFace size={20} />}
            >
              <AgentFace id={message.entry.actor.agentId} size={20} />
            </If>
          </If>
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <If when={message.head}>
            <View style={{ ...row, gap: 8, alignItems: "baseline" }}>
              <Label variant="small" weight={600}>
                {name(message.entry.actor)}
              </Label>
              <Label variant="caption" tone="muted">
                {taskMoment(message.entry.createdAt)}
              </Label>
            </View>
          </If>
          <Markdown
            value={
              full() || !long() ? body() : `${body().slice(0, commentPreview)}…`
            }
            variant="small"
          />
          <If when={long()}>
            <View
              role="button"
              onPress={() => full.set(!full())}
              style={{ alignSelf: "flex-start", cursor: "pointer" }}
            >
              <Label variant="caption" tone="muted">
                {full() ? uiText("collapseFullText") : uiText("expandFullText")}
              </Label>
            </View>
          </If>
        </View>
      </View>
    );
  };
  return (
    <View>
      <If when={props.heading === "phone"}>
        <Caption text={uiText("activity")} />
      </If>
      <If when={props.heading === "desktop" || props.heading === "tablet"}>
        <Label
          weight={props.heading === "tablet" ? 600 : 700}
          style={{ paddingBottom: 4 }}
        >
          {uiText("activity")}
        </Label>
      </If>
      <Each
        of={items()}
        key={(item) =>
          item.kind === "updates" ? `u-${item.entries[0]!.id}` : item.entry.id
        }
      >
        {(item) => {
          const at = item();
          if (at.kind === "updates") return <Updates entries={at.entries} />;
          if (at.kind === "message")
            return <Message entry={at.entry} head={at.head} />;
          return (
            <View style={{ paddingTop: 6, paddingLeft: indent() }}>
              <Line entry={at.entry} />
            </View>
          );
        }}
      </Each>
    </View>
  );
}
