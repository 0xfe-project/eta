import type {
  ArtifactView,
  AttachmentView,
  BoardTaskStatus,
  BoardTaskView,
  TaskActivityView,
  TaskActor,
  TaskRunView,
} from "@eta/client-contracts";
import {
  dependencyEntry,
  parentEntry,
  subtaskEntry,
} from "@eta/client-contracts";
import { signal, Text, View } from "nsh";
import {
  Caption,
  colors,
  focusRing,
  fontFamily,
  Fonts,
  Icon,
  Label,
  Markdown,
  row,
  textFaces,
  textStyle,
} from "../../components";
import { AgentFace, UserFace } from "../../components/agent-face";
import { EmptyState } from "../../components/empty-state";
import { chatText, shownFiles } from "../../components/eta-editor";
import { canHover, touchScreen } from "../../components/menu";
import { densityDefaults } from "../../components/theme";
import { icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { problemReason } from "../../services/problem-text";
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

/**
 * What an entry's sentence names that can be opened: another task (a prerequisite, the parent, a
 * subtask), or the version of an artifact it published. An entry written before the host kept the
 * other task's id names only its number.
 */
type ActivityTarget =
  | { kind: "task"; taskId: string | null; number: number; title: string }
  | {
      kind: "artifact";
      artifactId: string;
      /** The version the entry was written for; absent on an entry that did not say. */
      version: number | undefined;
      title: string;
    };

function activityTarget(entry: TaskActivityView): ActivityTarget | undefined {
  if (entry.kind === "dependency") {
    const edge = dependencyEntry(entry.data);
    if (!edge || edge.number === null || edge.action === "unblocked")
      return undefined;
    return {
      kind: "task",
      taskId: edge.taskId,
      number: edge.number,
      title: edge.title,
    };
  }
  if (entry.kind === "parent") {
    const parent = parentEntry(entry.data);
    const ref = parent?.to ?? parent?.from;
    return ref ? { kind: "task", ...ref } : undefined;
  }
  if (entry.kind === "subtask") {
    const subtask = subtaskEntry(entry.data);
    return subtask && subtask.action !== "all_cancelled"
      ? { kind: "task", ...subtask.task }
      : undefined;
  }
  if (
    entry.kind === "artifact" &&
    typeof entry.data.artifactId === "string" &&
    typeof entry.data.title === "string"
  )
    return {
      kind: "artifact",
      artifactId: entry.data.artifactId,
      version:
        typeof entry.data.version === "number" ? entry.data.version : undefined,
      title: entry.data.title,
    };
  return undefined;
}

/** How a target reads in its sentence: its title, or a task's number when it has none. */
const targetName = (target: ActivityTarget) =>
  target.title || (target.kind === "task" ? `#${target.number}` : "");

/**
 * What an entry says on a desktop task page: a sentence, the task at the other end quoted.
 * `name` stands in for the quoted title, so a caller can find where it goes.
 */
function taskActivitySentence(entry: TaskActivityView, name?: string): string {
  const quoted = (title: string) => name ?? title;
  if (inlineBody(entry)) {
    // A raw code ("returned 529") is not a reason: the line then just says how the turn ended.
    const reason = problemReason(entry.body!.trim().replace(/\s+/g, " "));
    const failed = entry.kind === "run_failed";
    if (!reason)
      return uiText(
        failed ? "activityTurnFailedBare" : "activityTurnStoppedBare",
      );
    return uiText(failed ? "activityTurnFailed" : "activityTurnStopped", {
      reason,
    });
  }
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
      const title = quoted(edge.title || `#${edge.number}`);
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
    const parent = parentEntry(entry.data);
    if (parent?.to)
      return uiText("activityParent", {
        title: quoted(parent.to.title || `#${parent.to.number}`),
      });
    if (parent?.from)
      return uiText("activityParentRemoved", {
        title: quoted(parent.from.title || `#${parent.from.number}`),
      });
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
        { title: quoted(subtask.task.title || `#${subtask.task.number}`) },
      );
  }
  if (entry.kind === "title" && typeof entry.data.to === "string")
    return uiText("activityRenamed", { title: entry.data.to });
  if (entry.kind === "artifact" && typeof entry.data.title === "string")
    return uiText("activityArtifact", { title: quoted(entry.data.title) });
  if (entry.kind === "conversation")
    return uiText(
      entry.data.to ? "activityConversation" : "activityConversationRemoved",
    );
  if (entry.kind === "created") return uiText("activityCreated");
  if (entry.kind === "comment") return uiText("activityCommented");
  return uiText(activityKeys[entry.kind] ?? "activityChanged");
}

/** Stands in for a target's title while a sentence is split around it. */
const slot = "\u0000";

/** An entry's sentence in three parts, its target's name in the middle; undefined when it has none. */
function sentenceAround(
  entry: TaskActivityView,
): [string, string, string] | undefined {
  const target = activityTarget(entry);
  if (!target) return undefined;
  const sentence = taskActivitySentence(entry, slot);
  const at = sentence.indexOf(slot);
  if (at < 0) return undefined;
  return [
    sentence.slice(0, at),
    targetName(target),
    sentence.slice(at + slot.length),
  ];
}

// --- the thread -------------------------------------------------------------------------
//
// A task's history reads as a thread: what was said is a
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

/** How many agents a comment's pictures went to as files only (`data.imagesUnseenBy`). */
const unseenCount = (entry: TaskActivityView) =>
  Array.isArray(entry.data.imagesUnseenBy)
    ? entry.data.imagesUnseenBy.length
    : 0;

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
  /** Go to another task the timeline names, the way its task links go there. */
  onTask?: (id: string) => void;
  /** Open an artifact the timeline names, at the version the entry was written for. */
  onArtifact?: (artifact: ArtifactView, version?: number) => void;
}) {
  const host = useHost();
  const c = colors();
  const fonts = Fonts();
  const type = textFaces();
  // What a named task or artifact is now: one gone, or out of this board's reach, cannot be opened.
  follow(() => (props.onTask ? "tasks" : undefined));
  follow(() => (props.onArtifact ? "artifacts" : undefined));
  /** An author's face: the density's (24 in a task's page, 16 in the side panel). */
  const face = densityDefaults();
  const gap = () => props.gap ?? 8;
  const indent = () => face().avatar + gap();
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
  /** What a target is now: open it, it is gone, or nothing is known yet (the lists are loading). */
  const resolve = (
    target: ActivityTarget,
  ): { open: () => void } | "gone" | undefined => {
    if (target.kind === "artifact") {
      const open = props.onArtifact;
      const list = host.section<ArtifactView[]>("artifacts", "list");
      if (!open || !list) return undefined;
      const artifact = list.find((item) => item.id === target.artifactId);
      if (!artifact) return "gone";
      // The version it was written for, or the newest once that one is gone.
      const version = artifact.versions.some(
        (item) => item.number === target.version,
      )
        ? target.version
        : undefined;
      return { open: () => open(artifact, version) };
    }
    const open = props.onTask;
    const list = host.section<BoardTaskView[]>("tasks", "list");
    if (!open || !list) return undefined;
    const tasks = [...list, ...host.list<BoardTaskView>("tasks", "archived")];
    const task =
      target.taskId === null
        ? tasks.find((item) => item.number === target.number)
        : tasks.find((item) => item.id === target.taskId);
    return task ? { open: () => open(task.id) } : "gone";
  };
  /**
   * A sentence around a named target, rendered as one inline paragraph so quotes and trailing
   * words wrap continuously with the title. While the target can be opened, the paragraph carries
   * the link role, label and keyboard focus ring, and the title span highlights on hover or focus.
   */
  const TargetSentence = (sentence: {
    target: ActivityTarget;
    parts: [string, string, string];
  }) => {
    const focused = signal(false);
    const state = () => resolve(sentence.target);
    const label = () =>
      sentence.target.kind === "artifact"
        ? uiText("activityOpenArtifact", { title: sentence.parts[1] })
        : uiText("activityOpenTask", {
            number: sentence.target.number,
            title: sentence.target.title || `#${sentence.target.number}`,
          });
    return (
      <If
        when={typeof state() === "object" ? state() : undefined}
        else={
          <Label
            variant="caption"
            tone="muted"
            style={{ flexShrink: 1, minWidth: 0 }}
          >
            {`${sentence.parts[0]}${sentence.parts[1]}${sentence.parts[2]}`}
          </Label>
        }
      >
        {(target) => {
          const open = () => (target() as { open: () => void }).open();
          return (
            <Text
              role="link"
              accessibilityLabel={label()}
              onPress={open}
              onFocus={() => focused.set(true)}
              onBlur={() => focused.set(false)}
              focusVisibleStyle={focusRing(c())}
              hitSlop={
                touchScreen
                  ? { top: 12, bottom: 12, left: 6, right: 6 }
                  : undefined
              }
              style={{
                fontFamily: fontFamily(fonts().interface),
                ...textStyle(type("caption")),
                fontWeight: weight.regular,
                color: c().muted,
                flexShrink: 1,
                minWidth: 0,
              }}
            >
              {sentence.parts[0]}
              <Text
                focusable={false}
                onPress={open}
                hoverStyle={
                  canHover
                    ? { color: c().blue, textDecorationLine: "underline" }
                    : undefined
                }
                style={{
                  color: focused() ? c().blue : c().ink,
                  textDecorationLine: focused() ? "underline" : "none",
                  textDecorationThickness: 1,
                  cursor: "pointer",
                }}
              >
                {sentence.parts[1]}
              </Text>
              {sentence.parts[2]}
            </Text>
          );
        }}
      </If>
    );
  };
  const Line = (line: { entry: TaskActivityView }) => {
    const mark = () =>
      line.entry.kind === "dependency"
        ? dependencyIcon(line.entry)
        : line.entry.kind === "artifact"
          ? { name: "appWindow" as const, tone: "muted" as const }
          : undefined;
    const run = () => runOf(line.entry);
    const parts = () => sentenceAround(line.entry);
    /** An artifact deleted since says so; a task gone is only no longer a link. */
    const gone = () => {
      const target = activityTarget(line.entry);
      return target?.kind === "artifact" && resolve(target) === "gone";
    };
    return (
      <View style={{ ...row, alignItems: "flex-start", gap: space[4] }}>
        <View
          style={{
            ...row,
            gap: space[4],
            flexShrink: 0,
            minHeight: type("caption").line,
          }}
        >
          <Label variant="caption" tone="muted">
            {name(lineActor(line.entry))}
          </Label>
          <If when={mark()}>
            {(glyph) => (
              <Icon name={glyph().name} size={icon.sm} tone={glyph().tone} />
            )}
          </If>
        </View>
        <View
          style={{
            ...row,
            gap: space[4],
            flexWrap: "wrap",
            flex: 1,
            minWidth: 0,
          }}
        >
          <If
            when={parts()}
            else={
              <Label
                variant="caption"
                tone={line.entry.kind === "run_failed" ? "red" : "muted"}
                style={{ flexShrink: 1, minWidth: 0 }}
              >
                {taskActivitySentence(line.entry)}
              </Label>
            }
          >
            {(part) => (
              <TargetSentence
                target={activityTarget(line.entry)!}
                parts={part()}
              />
            )}
          </If>
          <If when={gone()}>
            <Label variant="caption" tone="faint">
              {uiText("activityArtifactDeleted")}
            </Label>
          </If>
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
      <View
        style={{ gap: space[4], paddingTop: space[8], paddingLeft: indent() }}
      >
        <View
          role="button"
          accessibilityLabel={label()}
          accessibilityState={{ expanded: open() }}
          onPress={() => open.set(!open())}
          style={{
            ...row,
            gap: space[4],
            alignSelf: "flex-start",
            cursor: "pointer",
          }}
        >
          <Icon
            name={open() ? "down" : "right"}
            size={icon.sm}
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
  // A comment's files as a chat message shows them: a file saves, a picture opens large, and
  // pictures are chips or cards as Settings › Appearance › Images in messages says.
  const shown = [shownFiles()];
  const Message = (message: { entry: TaskActivityView; head: boolean }) => {
    const full = signal(false);
    const body = () => message.entry.body ?? "";
    const long = () => body().length > commentPreview;
    const files = () =>
      Array.isArray(message.entry.data.attachments)
        ? (message.entry.data.attachments as AttachmentView[])
        : [];
    /** The agents its pictures went to as files only: their models take no images. */
    const unseenBy = () =>
      Array.isArray(message.entry.data.imagesUnseenBy)
        ? (message.entry.data.imagesUnseenBy as string[])
        : [];
    return (
      <View
        style={{
          ...row,
          alignItems: "flex-start",
          gap: gap(),
          paddingTop: message.head ? space[12] : space[4],
        }}
      >
        <View style={{ width: face().avatar, flexShrink: 0 }}>
          <If when={message.head}>
            <If
              when={message.entry.actor.kind === "agent"}
              else={<UserFace size={face().avatar} />}
            >
              <AgentFace
                id={message.entry.actor.agentId}
                size={face().avatar}
              />
            </If>
          </If>
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
          <If when={message.head}>
            <View style={{ ...row, gap: space[8], alignItems: "baseline" }}>
              <Label variant="small" weight={weight.strong}>
                {name(message.entry.actor)}
              </Label>
              <Label variant="caption" tone="muted">
                {taskMoment(message.entry.createdAt)}
              </Label>
            </View>
          </If>
          <If when={body()}>
            <Markdown
              value={
                full() || !long()
                  ? body()
                  : `${body().slice(0, commentPreview)}…`
              }
              variant="small"
            />
          </If>
          <If when={files().length > 0}>
            <chatText.View
              text={{ text: "", files: files() }}
              plugins={shown}
              variant="small"
              label={uiText("commentFiles")}
            />
          </If>
          <If when={unseenBy().length > 0}>
            <Label variant="caption" tone="muted">
              {uiText("commentImagesUnseen", {
                names: unseenBy()
                  .map((id) => host.agent(id)?.name ?? id)
                  .join(", "),
              })}
            </Label>
          </If>
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
        <Label weight={weight.strong} style={{ paddingBottom: space[4] }}>
          {uiText("activity")}
        </Label>
      </If>
      <Each
        of={items()}
        key={(item) =>
          item.kind === "updates"
            ? `u-${item.entries[0]!.id}`
            : // A row is drawn once per key: a comment the host later says more about (its
              // pictures were not shown to an agent) is drawn again.
              `${item.entry.id}:${unseenCount(item.entry)}`
        }
      >
        {(item) => {
          const at = item();
          if (at.kind === "updates") return <Updates entries={at.entries} />;
          if (at.kind === "message")
            return <Message entry={at.entry} head={at.head} />;
          return (
            <View style={{ paddingTop: space[8], paddingLeft: indent() }}>
              <Line entry={at.entry} />
            </View>
          );
        }}
      </Each>
      <If when={props.heading && !items().length}>
        <EmptyState
          size="row"
          status="empty"
          loading={null}
          error={null}
          empty={{ title: uiText("noActivityYet") }}
          style={{ paddingHorizontal: 0 }}
        />
      </If>
    </View>
  );
}
