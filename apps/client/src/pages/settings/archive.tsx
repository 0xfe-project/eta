import type {
  BoardTaskView,
  ConversationSummary,
  TaskBoardSettings,
} from "@eta/client-contracts";
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
import { emptyStyle, EntityRow, SectionHeader } from "./section";

export function ArchiveSettings() {
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
  return (
    <View style={grow}>
      <If when={host.can("tasks.setSettings")}>
        <SectionHeader title={uiText("autoArchive")} />
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
          <ActionMenu
            label={uiText("autoArchiveQuietPeriod")}
            value={saving() ? "Saving…" : dayLabel(days())}
            triggerStyle={{
              width: 160,
              height: 24,
              paddingLeft: 10,
              paddingRight: 8,
            }}
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
        </View>
      </If>
      <SectionHeader
        title={text("archived")}
        count={conversations().length + tasks().length || undefined}
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
                leading={<Icon name="archive" size={16} tone="muted" />}
                meta={
                  host
                    .projects()
                    .find((project) => project.id === item().projectId)
                    ?.display ?? ""
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
                leading={<Icon name="tasks" size={16} tone="muted" />}
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
