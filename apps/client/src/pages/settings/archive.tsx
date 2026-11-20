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
  Button,
  Caption,
  colors,
  Empty,
  grow,
  Label,
  row,
} from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

export function ArchiveSettings() {
  const host = useHost();
  const c = colors();
  const saving = signal(false);
  const days = () => {
    const stored = host.section<TaskBoardSettings>("tasks", "settings");
    return stored ? stored.archiveAfterDays : DEFAULT_TASK_ARCHIVE_DAYS;
  };
  const dayLabel = (value: number | null) =>
    value === null ? "Never" : `${value} days`;
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
  return (
    <View style={grow}>
      <If when={host.can("tasks.setSettings")}>
        <View
          style={{
            padding: 16,
            gap: 7,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <Label weight={600}>{uiText("autoArchive")}</Label>
          <View style={{ ...row, gap: 8 }}>
            <Label size={12} tone="muted" style={{ flex: 1 }}>
              {uiText("archiveFinishedTasksAfterTheyAre")}
            </Label>
            <ActionMenu
              label={uiText("autoArchiveQuietPeriod")}
              value={saving() ? "Saving…" : dayLabel(days())}
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
        </View>
      </If>
      <If
        when={conversations().length + tasks().length}
        else={<Empty title={uiText("nothingArchived")} />}
      >
        <Scroll style={grow}>
          <View style={{ padding: 12, gap: 8 }}>
            <If when={conversations().length}>
              <Caption
                text={uiText("archivedGroups", {
                  length: conversations().length,
                })}
              />
            </If>
            <Each
              of={conversations()}
              key={(item: ConversationSummary) => item.id}
            >
              {(item) => (
                <View style={{ ...row, gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Label>{item().name}</Label>
                    <Label size={11} tone="muted">
                      {host
                        .projects()
                        .find((project) => project.id === item().projectId)
                        ?.display ?? ""}
                    </Label>
                  </View>
                  <Button
                    label={uiText("restore")}
                    onPress={() =>
                      void host.action(() =>
                        host.call("conversations", "update", {
                          conversationId: item().id,
                          archived: false,
                        }),
                      )
                    }
                  />
                </View>
              )}
            </Each>
            <If when={tasks().length}>
              <Caption
                text={uiText("archivedTasks", { length: tasks().length })}
              />
            </If>
            <Each of={tasks()} key={(item) => item.id}>
              {(item) => (
                <View style={{ ...row, gap: 8 }}>
                  <Label style={{ flex: 1 }}>
                    {`#${item().number} ${item().title}`}
                  </Label>
                  <Button
                    label={uiText("restore")}
                    onPress={() =>
                      void host.action(() =>
                        host.call("tasks", "unarchive", { taskId: item().id }),
                      )
                    }
                  />
                </View>
              )}
            </Each>
          </View>
        </Scroll>
      </If>
    </View>
  );
}
