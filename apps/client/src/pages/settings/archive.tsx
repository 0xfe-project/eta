import type {
  BoardTaskView,
  ConversationSummary,
  TaskBoardSettings,
  TaskDraftTimeout,
} from "@eta/client-contracts";
import type { ViewStyle } from "nsh";
import {
  DEFAULT_TASK_ARCHIVE_DAYS,
  TASK_ARCHIVE_DAYS,
  TASK_DRAFT_TIMEOUT_ACTIONS,
  TASK_DRAFT_TIMEOUT_MINUTES,
} from "@eta/client-contracts";
import { Scroll, signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  Empty,
  Field,
  grow,
  Icon,
  Label,
  row,
} from "../../components";
import { formatLocale, uiText, useText } from "../../i18n";
import { ToggleSwitch } from "../../components/toggle-switch";
import { useHost } from "../../services/host";
import { messageTime } from "../chat/message-time";
import { TaskGlyph } from "../tasks/status";
import { emptyStyle, EntityRow, SectionHeader } from "./section";

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
  const timeout = (): TaskDraftTimeout =>
    host.section<TaskBoardSettings>("tasks", "settings")?.draftTimeout ?? {
      enabled: false,
      minutes: TASK_DRAFT_TIMEOUT_MINUTES.default,
      action: "discard",
    };
  async function saveTimeout(change: Partial<TaskDraftTimeout>) {
    if (saving()) return;
    saving.set(true);
    await host.action(() =>
      host.call("tasks", "setSettings", { draftTimeout: change }),
    );
    saving.set(false);
  }
  // The minutes field keeps what is typed until it is committed; what the host kept is shown again.
  const typed = signal<string | undefined>(undefined);
  const minutesInvalid = signal(false);
  const range = {
    min: TASK_DRAFT_TIMEOUT_MINUTES.min,
    max: TASK_DRAFT_TIMEOUT_MINUTES.max,
  };
  async function commitMinutes() {
    const text = (typed() ?? "").trim();
    typed.set(undefined);
    if (text === "") {
      minutesInvalid.set(false);
      return;
    }
    const value = Number(text);
    if (!Number.isInteger(value) || value < range.min || value > range.max) {
      minutesInvalid.set(true);
      return;
    }
    minutesInvalid.set(false);
    if (value !== timeout().minutes) await saveTimeout({ minutes: value });
  }
  const actionLabel = (action: TaskDraftTimeout["action"]) =>
    uiText(action === "accept" ? "draftTimeoutAccept" : "draftTimeoutDiscard");
  const timeoutRowStyle = {
    ...row,
    minHeight: 40,
    gap: 16,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderColor: c().border,
  };
  const conversations = () =>
    host.conversations().filter((item) => item.archived);
  const tasks = () => host.list<BoardTaskView>("tasks", "archived");
  const restoreConversation = (id: string) =>
    void host.action(() =>
      host.call("conversations", "update", {
        conversationId: id,
        archived: false,
      }),
    );
  const restoreTask = (id: string) =>
    void host.action(() => host.call("tasks", "unarchive", { taskId: id }));
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
                minHeight: 40,
                gap: 16,
                paddingHorizontal: 16,
                paddingVertical: 8,
                borderBottomWidth: 1,
                borderColor: c().border,
              }}
            >
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Label>{uiText("archiveFinishedTasksAfterTheyAre")}</Label>
                <Label variant="small" tone="muted">
                  {uiText("autoArchiveHint")}
                </Label>
              </View>
              {quietPeriod({
                width: 160,
                height: 24,
                paddingLeft: 10,
                paddingRight: 8,
              })}
            </View>
          }
        >
          <View
            style={{
              gap: 6,
              paddingHorizontal: 16,
              paddingVertical: 8,
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label>{uiText("archiveFinishedTasksAfterTheyAre")}</Label>
            {quietPeriod({ height: 32, paddingHorizontal: 10 })}
            <Label variant="small" tone="muted">
              {uiText("autoArchivePhoneHint")}
            </Label>
          </View>
        </If>
        <SectionHeader title={uiText("taskDraftTimeout")} phone={props.phone} />
        <View style={timeoutRowStyle}>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Label>{uiText("draftTimeoutEnabled")}</Label>
            <Label variant="small" tone="muted">
              {uiText("draftTimeoutEnabledHint")}
            </Label>
          </View>
          <ToggleSwitch
            label={uiText("draftTimeoutEnabled")}
            checked={timeout().enabled}
            disabled={saving()}
            onChange={(value) => void saveTimeout({ enabled: value })}
          />
        </View>
        <View style={timeoutRowStyle}>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Label>{uiText("draftTimeoutMinutes")}</Label>
            <Label variant="small" tone={minutesInvalid() ? "red" : "muted"}>
              {uiText(
                minutesInvalid()
                  ? "draftTimeoutMinutesInvalid"
                  : "draftTimeoutMinutesHint",
                range,
              )}
            </Label>
          </View>
          <Field
            label={uiText("draftTimeoutMinutes")}
            value={typed() ?? String(timeout().minutes)}
            maxLength={4}
            style={{ width: 72, height: 28 }}
            onChange={(value) => typed.set(value)}
            onSubmit={() => void commitMinutes()}
            onBlur={() => void commitMinutes()}
          />
          <Label variant="small" tone="muted">
            {uiText("draftTimeoutMinutesUnit")}
          </Label>
        </View>
        <View style={timeoutRowStyle}>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Label>{uiText("draftTimeoutAction")}</Label>
            <Label variant="small" tone="muted">
              {uiText("draftTimeoutActionHint")}
            </Label>
          </View>
          <ActionMenu
            label={uiText("draftTimeoutAction")}
            value={actionLabel(timeout().action)}
            triggerStyle={{
              width: 160,
              height: 24,
              paddingLeft: 10,
              paddingRight: 8,
            }}
          >
            <Each of={[...TASK_DRAFT_TIMEOUT_ACTIONS]}>
              {(choice) => (
                <ActionItem
                  label={actionLabel(choice())}
                  checked={choice() === timeout().action}
                  onSelect={() => {
                    if (choice() !== timeout().action)
                      void saveTimeout({ action: choice() });
                  }}
                />
              )}
            </Each>
          </ActionMenu>
        </View>
      </If>
      <Scroll style={grow} scrollbar={false}>
        <SectionHeader
          title={text("archived")}
          count={conversations().length || undefined}
          phone={props.phone}
        />
        <If
          when={conversations().length}
          else={
            <View
              style={{
                paddingHorizontal: 16,
                paddingVertical: 12,
                borderBottomWidth: 1,
                borderColor: c().border,
              }}
            >
              <Label variant="small" tone="muted">
                {uiText("archivedConversationsEmpty")}
              </Label>
            </View>
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
                    <Icon name="archive" size={16} tone="muted" />
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
            <Empty
              icon="archive"
              iconSize={24}
              title={uiText("archivedTasksEmpty")}
              titleWeight={500}
              description={uiText("archivedTasksEmptyHint")}
              descriptionWidth={360}
              style={emptyStyle}
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
      </Scroll>
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
        minHeight: 40,
        flexShrink: 0,
        gap: 10,
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <View
        style={{
          width: 24,
          height: 24,
          flexShrink: 0,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <TaskGlyph status={props.task.status} size={14} />
      </View>
      <Label variant="small" tone="muted" style={{ width: 32, flexShrink: 0 }}>
        {`#${props.task.number}`}
      </Label>
      <Label style={{ flex: 1, minWidth: 0 }}>{props.task.title}</Label>
      <Label variant="small" tone="muted" style={{ flexShrink: 0 }}>
        {`${by()} · ${when()}`}
      </Label>
      <Button
        label={uiText("restore")}
        size={24}
        style={{ flexShrink: 0, paddingHorizontal: 8 }}
        onPress={props.onRestore}
      />
    </View>
  );
}
