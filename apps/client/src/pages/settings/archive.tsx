import type {
  BoardTaskView,
  ConversationSummary,
  TaskBoardSettings,
} from "@eta/client-contracts";
import type { ViewStyle } from "nsh";
import {
  DEFAULT_TASK_ARCHIVE_DAYS,
  TASK_ARCHIVE_DAYS,
} from "@eta/client-contracts";
import { signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  grow,
  Icon,
  Label,
  row,
  SmoothScroll,
} from "../../components";
import { EmptyState } from "../../components/empty-state";
import { showToast } from "../../components/toast";
import { control, icon, space } from "../../components/tokens";
import { formatLocale, uiText, useText } from "../../i18n";
import { useHost } from "../../services/host";
import { useLoadState } from "../../services/load-status";
import { messageTime } from "../chat/message-time";
import { TaskGlyph } from "../tasks/status";
import { EntityRow, SectionHeader } from "./section";

/** The quiet-period menu beside its label. */
const quietPeriodWidth = 160;

export function ArchiveSettings(props: { phone?: boolean }) {
  const host = useHost();
  const c = colors();
  const text = useText();
  const saving = signal(false);
  const days = () => {
    const stored = host.section<TaskBoardSettings>("tasks", "settings");
    return stored ? stored.archiveAfterDays : DEFAULT_TASK_ARCHIVE_DAYS;
  };
  const dayLabel = (value: number | null) => {
    const label = value === null ? "Never" : `${value} days`;
    return value === DEFAULT_TASK_ARCHIVE_DAYS
      ? uiText("autoArchiveDefault", { label })
      : label;
  };
  async function setDays(value: TaskBoardSettings["archiveAfterDays"]) {
    if (saving() || value === days()) return;
    saving.set(true);
    await host.action(() =>
      host.call("tasks", "setSettings", { archiveAfterDays: value }),
    );
    saving.set(false);
  }
  const restoredConversations = signal<string[]>([]);
  const restoredTasks = signal<string[]>([]);
  const conversations = () =>
    host
      .conversations()
      .filter(
        (item) => item.archived && !restoredConversations().includes(item.id),
      );
  const tasks = () =>
    host
      .list<BoardTaskView>("tasks", "archived")
      .filter((item) => !restoredTasks().includes(item.id));
  const tasksLoad = useLoadState({ targets: () => ["tasks"] });
  const conversationsLoad = useLoadState({ targets: () => ["conversations"] });
  const restoreConversation = (id: string) => {
    restoredConversations.update((all) =>
      all.includes(id) ? all : [...all, id],
    );
    void host
      .optimistic(id, { archived: false }, () =>
        host.call("conversations", "update", {
          conversationId: id,
          archived: false,
        }),
      )
      .then(() => {
        setTimeout(() => {
          restoredConversations.update((all) =>
            all.filter((item) => item !== id),
          );
        }, 1500);
      })
      .catch((problem: unknown) => {
        restoredConversations.update((all) =>
          all.filter((item) => item !== id),
        );
        showToast({
          title: uiText("saveFailed"),
          body: problem instanceof Error ? problem.message : String(problem),
          tone: "red",
          action: {
            label: uiText("retry"),
            onPress: () => restoreConversation(id),
          },
        });
      });
  };
  const restoreTask = (id: string) => {
    restoredTasks.update((all) => (all.includes(id) ? all : [...all, id]));
    void host
      .optimistic(id, { archivedAt: null }, () =>
        host.call("tasks", "unarchive", { taskId: id }),
      )
      .then(() => {
        setTimeout(() => {
          restoredTasks.update((all) => all.filter((item) => item !== id));
        }, 1500);
      })
      .catch((problem: unknown) => {
        restoredTasks.update((all) => all.filter((item) => item !== id));
        showToast({
          title: uiText("saveFailed"),
          body: problem instanceof Error ? problem.message : String(problem),
          tone: "red",
          action: {
            label: uiText("retry"),
            onPress: () => restoreTask(id),
          },
        });
      });
  };
  const quietPeriod = (style: ViewStyle) => (
    <ActionMenu
      label={uiText("autoArchiveQuietPeriod")}
      value={saving() ? uiText("autoArchiveSaving") : dayLabel(days())}
      triggerStyle={style}
    >
      <Each of={[...TASK_ARCHIVE_DAYS, null]}>
        {(choice) => (
          <ActionItem
            label={dayLabel(choice())}
            checked={choice() === days()}
            onSelect={() => void setDays(choice())}
          />
        )}
      </Each>
    </ActionMenu>
  );
  return (
    <View style={grow}>
      <If when={host.can("tasks.setSettings")}>
        <SectionHeader title={uiText("autoArchive")} phone={props.phone} />
        <If
          when={props.phone}
          else={
            <View
              style={{
                ...row,
                minHeight: space[40],
                gap: space[16],
                paddingHorizontal: space[16],
                paddingVertical: space[8],
                borderBottomWidth: 1,
                borderColor: c().border,
              }}
            >
              <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
                <Label>{uiText("archiveFinishedTasksAfterTheyAre")}</Label>
                <Label variant="small" tone="muted">
                  {uiText("autoArchiveHint")}
                </Label>
              </View>
              {quietPeriod({
                width: quietPeriodWidth,
                height: space[24],
                paddingLeft: space[12],
                paddingRight: space[8],
              })}
            </View>
          }
        >
          <View
            style={{
              gap: space[4],
              paddingHorizontal: space[16],
              paddingVertical: space[8],
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label>{uiText("archiveFinishedTasksAfterTheyAre")}</Label>
            {quietPeriod({ height: space[32], paddingHorizontal: space[12] })}
            <Label variant="small" tone="muted">
              {uiText("autoArchivePhoneHint")}
            </Label>
          </View>
        </If>
      </If>
      <SmoothScroll style={grow} scrollbar={false}>
        <SectionHeader
          title={text("archived")}
          count={conversations().length || undefined}
          phone={props.phone}
        />
        <If
          when={conversations().length}
          else={
            <EmptyState
              size="row"
              status={conversationsLoad.shown()}
              loading={uiText("loadingConversations")}
              error={{
                title: uiText("conversationsDidNotLoad"),
                retry: conversationsLoad.retry,
                retrying: conversationsLoad.retrying(),
              }}
              empty={{ title: uiText("archivedConversationsEmpty") }}
              style={{
                paddingHorizontal: space[16],
                paddingVertical: space[12],
                borderBottomWidth: 1,
                borderColor: c().border,
              }}
            />
          }
        >
          <Each
            of={conversations()}
            key={(item: ConversationSummary) => item.id}
          >
            {(item) => (
              <EntityRow
                title={item().name}
                leading={
                  props.phone ? undefined : (
                    <Icon name="archive" size={icon.md} tone="muted" />
                  )
                }
                meta={
                  props.phone ? (
                    <Label variant="small" tone="muted" lines={2}>
                      {[
                        messageTime(
                          item().lastMessageAt ?? item().updatedAt,
                          false,
                        ),
                        item().preview,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </Label>
                  ) : (
                    (host
                      .projects()
                      .find((project) => project.id === item().projectId)
                      ?.display ?? "")
                  )
                }
                lane={false}
                menuLabel={item().name}
                menu={
                  <ActionItem
                    label={uiText("restore")}
                    onSelect={() => restoreConversation(item().id)}
                  />
                }
              />
            )}
          </Each>
        </If>
        <SectionHeader
          title={uiText("archivedTasks")}
          count={tasks().length || undefined}
          phone={props.phone}
        />
        <If
          when={tasks().length}
          else={
            <EmptyState
              size="card"
              status={tasksLoad.shown()}
              loading={uiText("loadingTasks")}
              error={{
                title: uiText("tasksDidNotLoad"),
                retry: tasksLoad.retry,
                retrying: tasksLoad.retrying(),
              }}
              empty={{
                art: "archive",
                title: uiText("archivedTasksEmpty"),
                description: uiText("archivedTasksEmptyHint"),
              }}
              style={{ paddingHorizontal: space[16] }}
            />
          }
        >
          <Each of={tasks()} key={(item) => item.id}>
            {(item) => (
              <ArchivedTaskRow
                task={item()}
                onRestore={() => restoreTask(item().id)}
              />
            )}
          </Each>
        </If>
      </SmoothScroll>
    </View>
  );
}

/** One archived task: its status, number and title, who put it away and when, and Restore. */
function ArchivedTaskRow(props: {
  task: BoardTaskView;
  onRestore: () => void;
}) {
  const host = useHost();
  const c = colors();
  const by = () => {
    const who = props.task.archivedBy;
    if (who === "auto") return uiText("archivedByAuto");
    if (who === "user" || who == null) return uiText("archivedByUser");
    return host.agent(who)?.name ?? who;
  };
  const when = () =>
    new Date(props.task.archivedAt ?? props.task.updatedAt).toLocaleDateString(
      formatLocale(),
      { month: "short", day: "numeric" },
    );
  return (
    <View
      style={{
        ...row,
        minHeight: space[40],
        flexShrink: 0,
        gap: space[8],
        paddingHorizontal: space[16],
        paddingVertical: space[8],
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <View
        style={{
          width: space[24],
          height: space[24],
          flexShrink: 0,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <TaskGlyph status={props.task.status} size={icon.md} />
      </View>
      <Label
        variant="small"
        tone="muted"
        style={{ width: space[32], flexShrink: 0 }}
      >
        {`#${props.task.number}`}
      </Label>
      <Label style={{ flex: 1, minWidth: 0 }}>{props.task.title}</Label>
      <Label variant="small" tone="muted" style={{ flexShrink: 0 }}>
        {`${by()} · ${when()}`}
      </Label>
      <Button
        label={uiText("restore")}
        size={control.sm}
        style={{ flexShrink: 0, paddingHorizontal: space[8] }}
        onPress={props.onRestore}
      />
    </View>
  );
}
