import type { BoardTaskStatus, BoardTaskView } from "@eta/client-contracts";
import type { Layout } from "../../components";
import type { taskDropZones } from "./drag";
import { Scroll, View } from "nsh";
import { colors, grow, Label, row } from "../../components";
import { BoardCard } from "./board-card";
import { statusName, TaskGlyph } from "./status";

const mainStatuses: BoardTaskStatus[] = [
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
];

export const visibleStatuses: BoardTaskStatus[] = [
  ...mainStatuses,
  "backlog",
  "cancelled",
];

export function TaskWorkspaceBoard(props: {
  layout: Layout;
  items: BoardTaskView[];
  expanded: string[];
  drag: ReturnType<typeof taskDropZones<BoardTaskStatus>>;
  onFoldStatus: (status: string) => void;
  onOpen: (id: string) => void;
}) {
  const c = colors();
  const boardDrag = props.drag;
  const column = (status: BoardTaskStatus) =>
    props.items.filter((task) => task.status === status);
  return (
    <View
      style={{
        ...row,
        ...grow,
        paddingHorizontal: 22,
        paddingTop: 12,
        gap: 9,
        alignItems: "stretch",
      }}
    >
      <Each of={visibleStatuses}>
        {(status) => {
          const folded = () =>
            !mainStatuses.includes(status()) &&
            !props.expanded.includes(status());
          return (
            <View
              ref={(view) => boardDrag.register(status(), view)}
              style={{
                flex: folded() ? undefined : 1,
                width: folded() ? 32 : undefined,
                minWidth: 0,
                backgroundColor: folded() ? c().surface : c().canvas,
              }}
            >
              <View
                role="button"
                accessibilityLabel={statusName(status())}
                onPress={() => props.onFoldStatus(status())}
                style={
                  folded()
                    ? {
                        alignItems: "center",
                        paddingTop: 9,
                        gap: 7,
                        cursor: "pointer",
                      }
                    : {
                        ...row,
                        gap: 7,
                        height: 25,
                        paddingTop: 7,
                        paddingLeft: 2,
                        cursor: "pointer",
                      }
                }
              >
                <TaskGlyph status={status()} size={12.6} />
                <If
                  when={!folded()}
                  else={
                    <>
                      <View
                        style={{
                          width: 16,
                          height: railLength(statusName(status())),
                        }}
                      >
                        <Label
                          size={12}
                          line={16}
                          tone="muted"
                          lines={1}
                          style={{
                            position: "absolute",
                            top: railLength(statusName(status())) / 2 - 8,
                            left: 8 - railLength(statusName(status())) / 2,
                            width: railLength(statusName(status())),
                            transform: "rotate(90deg)",
                          }}
                        >
                          {statusName(status())}
                        </Label>
                      </View>
                      <Label size={12} line={16} tone="muted">
                        {column(status()).length}
                      </Label>
                    </>
                  }
                >
                  <Label size={12} line={16}>
                    {statusName(status())}
                  </Label>
                  <Label size={12} line={16} tone="muted">
                    {column(status()).length}
                  </Label>
                </If>
              </View>
              <If when={!folded()}>
                <Scroll style={{ ...grow, marginTop: 7 }} scrollbar={false}>
                  <View style={{ gap: 7 }}>
                    <Each of={column(status())} key={(task) => task.id}>
                      {(task) => (
                        <BoardCard
                          task={task()}
                          drag={boardDrag}
                          draggable={
                            props.layout === "desktop" && !task().subtasks
                          }
                          onOpen={() => props.onOpen(task().id)}
                        />
                      )}
                    </Each>
                  </View>
                </Scroll>
              </If>
            </View>
          );
        }}
      </Each>
    </View>
  );
}

/** How long a folded column's name runs once turned on its side. */
function railLength(name: string) {
  return Math.ceil(
    [...name].reduce(
      (length, char) => length + (char.charCodeAt(0) > 0x2e80 ? 12 : 6.8),
      0,
    ),
  );
}
