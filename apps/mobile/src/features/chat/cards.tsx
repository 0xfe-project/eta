import type {
  ArtifactRef,
  BoardTaskStatus,
  MessageView,
  TaskCardData,
  TaskDraftData,
  TaskRunStatus,
} from "@eta/client-contracts";
import type { TextKey } from "../../i18n";
import type { Chat } from "./conversation";
import { draftStatus } from "@eta/client-contracts";
import { Text, View } from "nsh";
import { t } from "../../i18n";
import { go } from "../../nav/links";
import { open } from "../../nav/stack";
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/Markdown";
import { StatusPill, TaskStatusIcon } from "../../ui/StatusIcon";
import { DraftScreen } from "./DraftScreen";

const STATUS: Record<BoardTaskStatus, TextKey> = {
  backlog: "chat.taskStatus.backlog",
  todo: "chat.taskStatus.todo",
  in_progress: "chat.taskStatus.inProgress",
  in_review: "chat.taskStatus.inReview",
  done: "chat.taskStatus.done",
  blocked: "chat.taskStatus.blocked",
  cancelled: "chat.taskStatus.cancelled",
};

export const taskStatusLabel = (status: BoardTaskStatus) => t(STATUS[status]);

const RUN_STATUS: Partial<Record<TaskRunStatus, TextKey>> = {
  queued: "chat.runStatus.queued",
  running: "chat.runStatus.running",
  completed: "chat.runStatus.completed",
  failed: "chat.runStatus.failed",
};

/** A task an agent proposed (03d): one line that says it waits, and the way to the form. */
export function DraftCard(props: { message: MessageView; chat: Chat }) {
  const draft = () => props.message.data as unknown as TaskDraftData;
  const expanded = () => props.chat.folds()[props.message.id] === true;
  // Discarded by the user (on another client): it waits for nothing, so it offers no confirm.
  const discarded = () => draft().discarded === true;
  return (
    <View class="border border-border-strong">
      <View
        role="button"
        accessibilityLabel={draft().title}
        onPress={() => props.chat.fold(props.message.id, !expanded())}
        class="h-11 shrink-0 flex-row items-center gap-2 px-[10px] active:bg-muted"
      >
        <Icon
          name={expanded() ? "caretDown" : "caretRight"}
          size={14}
          color="faint"
        />
        <Text class="line-clamp-1 grow basis-0 text-base leading-[18px] text-foreground">
          {draft().title}
        </Text>
        <Text
          class={`text-sm leading-4 ${discarded() ? "text-muted-foreground" : "text-foreground"}`}
        >
          {t(
            discarded()
              ? "chat.draft.discarded"
              : draftStatus(draft()) === "backlog"
                ? "chat.draft.waitingBacklog"
                : "chat.draft.waiting",
          )}
        </Text>
      </View>
      <If when={expanded()}>
        <View class="gap-2 px-[10px] pb-[10px]">
          <Markdown
            text={draft().description}
            class="text-md leading-[20px] text-foreground"
          />
          <Text class="text-sm leading-[18px] text-muted-foreground">
            {t(
              draft().workspace === "worktree"
                ? "chat.draft.hintWorktree"
                : "chat.draft.hintLocal",
            )}
          </Text>
          <If when={draftStatus(draft()) === "backlog"}>
            <Text class="text-sm leading-[18px] text-muted-foreground">
              {t("chat.draft.backlogHint")}
            </Text>
          </If>
        </View>
      </If>
      <If when={!discarded()}>
        <View class="flex-row px-[10px] pb-[10px]">
          <View
            role="button"
            accessibilityLabel={t("chat.draft.confirm")}
            onPress={() => {
              const message = props.message;
              open(`draft:${message.id}`, () => (
                <DraftScreen message={message} />
              ));
            }}
            class="h-9 grow basis-0 items-center justify-center bg-primary active:opacity-80"
          >
            <Text class="text-md leading-4 text-primary-foreground">
              {t("chat.draft.confirm")}
            </Text>
          </View>
        </View>
      </If>
    </View>
  );
}

/** A task as the conversation last heard of it (03d): the host refreshes the row. */
export function TaskCard(props: { message: MessageView }) {
  const card = () => props.message.data as unknown as TaskCardData;
  const meta = () => {
    const run =
      card().runStatus === null
        ? undefined
        : RUN_STATUS[card().runStatus as TaskRunStatus];
    return [
      run === undefined ? undefined : t(run),
      card().comments > 0
        ? t("chat.task.comments", { count: card().comments })
        : undefined,
    ]
      .filter((part) => part !== undefined)
      .join(" · ");
  };
  return (
    <If
      when={card().deleted !== true}
      else={
        <Text class="text-sm leading-[18px] text-muted-foreground">
          {t("chat.task.deleted", {
            number: card().number,
            title: card().title,
          })}
        </Text>
      }
    >
      <View
        role="button"
        accessibilityLabel={`#${card().number} ${card().title}`}
        onPress={() => go.task(card().taskId)}
        class="h-14 shrink-0 flex-row items-center gap-[10px] border border-border px-[10px] active:bg-muted"
      >
        <TaskStatusIcon status={card().status} size={18} />
        <View class="min-w-0 grow basis-0">
          <Text class="truncate text-base leading-[20px] text-foreground">
            #{card().number} {card().title}
          </Text>
          <If when={meta() !== ""}>
            <Text class="truncate text-sm leading-4 text-muted-foreground">
              {meta()}
            </Text>
          </If>
        </View>
        <StatusPill
          status={card().status}
          label={taskStatusLabel(card().status)}
          icon={false}
        />
        <Icon name="caretRight" size={14} color="faint" />
      </View>
    </If>
  );
}

/** What a turn published (03d), outside the process: a thing the reader is meant to open. */
export function ArtifactCard(props: { artifact: ArtifactRef }) {
  const label = () =>
    t("chat.artifact.label", {
      title: props.artifact.title,
      version: props.artifact.version,
    });
  return (
    <View
      role="button"
      accessibilityLabel={label()}
      onPress={() =>
        go.artifact(props.artifact.artifactId, props.artifact.version)
      }
      class="h-12 shrink-0 flex-row items-center gap-[10px] border border-border px-[10px] active:bg-muted"
    >
      <Icon name="appWindow" size={18} color="muted-foreground" />
      <Text class="truncate grow basis-0 text-base leading-[18px] text-foreground">
        {label()}
      </Text>
      <Icon name="caretRight" size={14} color="faint" />
    </View>
  );
}
