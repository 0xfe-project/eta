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
import { Scroll, signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  colors,
  Empty,
  grow,
  Icon,
  Label,
  row,
} from "../../components";
import { uiText, useText } from "../../i18n";
import { useHost } from "../../services/host";
import { messageTime } from "../chat/message-time";
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
                <Label line={20}>
                  {uiText("archiveFinishedTasksAfterTheyAre")}
                </Label>
                <Label size={12} line={16} tone="muted">
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
            <Label line={20}>
              {uiText("archiveFinishedTasksAfterTheyAre")}
            </Label>
            {quietPeriod({ height: 32, paddingHorizontal: 10 })}
            <Label size={12} line={16} tone="muted">
              {uiText("autoArchivePhoneHint")}
            </Label>
          </View>
        </If>
      </If>
      <SectionHeader
        title={text("archived")}
        count={conversations().length + tasks().length || undefined}
        phone={props.phone}
      />
      <If
        when={conversations().length + tasks().length}
        else={<Empty title={uiText("nothingArchived")} style={emptyStyle} />}
      >
        <Scroll style={grow} scrollbar={false}>
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
                    <Label size={12} line={16} tone="muted" lines={2}>
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
          <Each of={tasks()} key={(item) => item.id}>
            {(item) => (
              <EntityRow
                title={`#${item().number} ${item().title}`}
                leading={
                  props.phone ? undefined : (
                    <Icon name="tasks" size={16} tone="muted" />
                  )
                }
                lane={false}
                menuLabel={item().title}
                menu={
                  <ActionItem
                    label={uiText("restore")}
                    onSelect={() => restoreTask(item().id)}
                  />
                }
              />
            )}
          </Each>
        </Scroll>
      </If>
    </View>
  );
}
