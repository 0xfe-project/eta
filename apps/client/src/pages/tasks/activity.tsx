import type { BoardTaskStatus, TaskActivityView } from "@eta/client-contracts";
import { dependencyEntry, subtaskEntry } from "@eta/client-contracts";
import { signal, View } from "nsh";
import { Caption, Icon, Label, Markdown, row } from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { taskMoment, taskWhen } from "./facts";
import { statusKeys, statusName } from "./status";

/** The chat task panel's short label for an entry. */
export function taskActivityLabel(entry: TaskActivityView): string {
  if (entry.kind === "status") {
    const next = entry.data.to as BoardTaskStatus;
    if (Object.hasOwn(statusKeys, next)) return `moved to ${statusName(next)}`;
  }
  if (entry.kind === "dependency") {
    const edge = dependencyEntry(entry.data);
    if (edge) {
      if (edge.action === "unblocked") return "unblocked";
      const ref = `#${edge.number}`;
      if (edge.action === "added") return `waiting for ${ref}`;
      if (edge.action === "blocked") return `blocked by ${ref}`;
      return `dependency ${ref} ${
        edge.action === "required" ? "updated" : edge.action
      }`;
    }
  }
  return entry.kind.replaceAll("_", " ");
}

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

/** A phone entry opens like a sentence: "Ada · Started work". */
function capitalized(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The run's own bookkeeping and what the host wrote itself, folded away under "N updates" on desktop. */
function isQuiet(entry: TaskActivityView) {
  return entry.kind.startsWith("run_") || entry.actor.kind === "system";
}

export function TaskActivity(props: {
  entries: TaskActivityView[];
  phone: boolean;
  desktop?: boolean;
  /** The desktop sentences, tighter: one muted line each under a small heading. */
  tablet?: boolean;
}) {
  const host = useHost();
  const unfolded = signal(false);
  const actor = (entry: TaskActivityView) =>
    host.agent(entry.actor.agentId)?.name ??
    (entry.actor.kind === "user" ? uiText("taskMe") : "Eta");
  const quiet = () => props.entries.filter(isQuiet);
  return (
    <If
      when={props.desktop || props.tablet}
      else={
        <View style={{ gap: 6 }}>
          <Caption text={uiText("activity")} />
          <Each
            of={
              props.phone
                ? props.entries
                    .slice()
                    .reverse()
                    .filter((entry) => entry.kind !== "run_queued")
                : props.entries
            }
            key={(entry) => entry.id}
          >
            {(entry) => (
              <View style={{ gap: 2 }}>
                <Label size={12} line={16} tone="mutedInk">
                  {entry().kind === "created"
                    ? `${uiText("createdByName", { name: actor(entry()) })} · ${taskWhen(entry().createdAt)}`
                    : `${actor(entry())} · ${capitalized(taskActivitySentence(entry()))} · ${taskWhen(entry().createdAt)}`}
                </Label>
                <If when={entry().body && !inlineBody(entry())}>
                  <Markdown value={entry().body ?? ""} line={20} />
                </If>
              </View>
            )}
          </Each>
        </View>
      }
    >
      <View
        style={{
          gap: props.tablet ? 4 : 10,
          paddingBottom: props.tablet ? 0 : 16,
        }}
      >
        <Label
          size={props.tablet ? 13 : 14}
          line={props.tablet ? 16 : 18}
          weight={props.tablet ? 600 : 700}
        >
          {uiText("activity")}
        </Label>
        <Each
          of={props.entries.filter((entry) => unfolded() || !isQuiet(entry))}
          key={(entry) => entry.id}
        >
          {(entry) => (
            <View style={{ gap: 4, paddingLeft: props.tablet ? 0 : 35 }}>
              <If when={props.tablet}>
                <Label size={10} line={12} tone="mutedInk">
                  {`${actor(entry())} ${taskActivitySentence(entry())} ${taskMoment(entry().createdAt)}`}
                </Label>
              </If>
              <View
                style={{
                  ...row,
                  gap: 6,
                  flexWrap: "wrap",
                  display: props.tablet ? "none" : "flex",
                }}
              >
                <Label size={10} line={12} tone="muted">
                  {actor(entry())}
                </Label>
                <Label size={10} line={12} tone="muted">
                  {taskActivitySentence(entry())}
                </Label>
                <Label size={10} line={12} tone="muted">
                  {taskMoment(entry().createdAt)}
                </Label>
              </View>
              <If when={entry().body && !inlineBody(entry())}>
                <Markdown value={entry().body ?? ""} line={18} />
              </If>
            </View>
          )}
        </Each>
        <If when={!unfolded() && quiet().length}>
          <View
            role="button"
            accessibilityLabel={uiText(
              quiet().length === 1 ? "oneTaskUpdate" : "taskUpdates",
              { count: quiet().length },
            )}
            onPress={() => unfolded.set(true)}
            style={{
              ...row,
              gap: 6,
              paddingLeft: props.tablet ? 0 : 35,
              cursor: "pointer",
            }}
          >
            <If when={!props.tablet}>
              <Icon name="right" size={10} />
            </If>
            <Label
              size={10}
              line={12}
              tone={props.tablet ? "mutedInk" : "muted"}
            >
              {uiText(quiet().length === 1 ? "oneTaskUpdate" : "taskUpdates", {
                count: quiet().length,
              })}
            </Label>
          </View>
        </If>
      </View>
    </If>
  );
}
