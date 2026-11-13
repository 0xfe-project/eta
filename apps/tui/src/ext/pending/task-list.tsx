/** The `/tasks` layer: the open tasks, each opened to handle (when it waits) or to read and comment on. */
import type { LayerHandle } from "../../extensions/types";
import { Text } from "ink";
import { useShell, useTheme } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { LayerFrame } from "../../ui/components/layer-frame";
import { inkColor } from "../../ui/theme";
import { usePanelState } from "./hooks";
import { openItemLayer } from "./item-layer";
import { statusText } from "./labels";
import { pendingMessages } from "./messages";
import { isWaitingTask, openTasks, taskList } from "./model";
import { ScrollList } from "./scroll-list";

export function TaskList({ handle }: { handle: LayerHandle }) {
  const ctx = useShell();
  const t = useMessages(pendingMessages);
  const theme = useTheme();
  const state = usePanelState();
  const { open, closed } = openTasks(state);
  const empty = taskList(state).length === 0;

  const pick = (taskId: string) => {
    const task = open.find((candidate) => candidate.id === taskId);
    if (task === undefined) return;
    openItemLayer(
      ctx,
      { kind: "task", id: task.id },
      isWaitingTask(task) ? "pending" : "read",
      [handle],
    );
  };

  const footer = [t("keyMove"), t("keyPage"), t("keyOpen"), t("keyClose")].join(
    t("footerSeparator"),
  );
  return (
    <LayerFrame title={t("tasksTitle")} footer={footer}>
      <ScrollList
        lines={
          empty
            ? [{ kind: "heading", key: "empty", text: t("noTasks") }]
            : open.map((task) => ({
                kind: "choice",
                key: task.id,
                content: (
                  <Text>{`#${task.number} ${task.title}  ${t(statusText(task.status))}`}</Text>
                ),
              }))
        }
        onPick={pick}
        onEscape={handle.close}
      />
      {closed > 0 && (
        <Text color={inkColor(theme.muted)} wrap="truncate-end">
          {t("closedTasks", { count: closed })}
        </Text>
      )}
    </LayerFrame>
  );
}
