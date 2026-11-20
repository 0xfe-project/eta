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
        gap: 8,
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
                width: folded() ? 34 : undefined,
                minWidth: 0,
                backgroundColor: folded() ? c().surface : c().canvas,
              }}
            >
              <View
                role="button"
                accessibilityLabel={statusName(status())}
                onPress={() => props.onFoldStatus(status())}
                style={{
                  ...row,
                  gap: 7,
                  minHeight: 32,
                  justifyContent: folded() ? "center" : "flex-start",
                }}
              >
                <TaskGlyph status={status()} size={12.6} />
                <If when={!folded()}>
                  <Label size={12}>{statusName(status())}</Label>
                  <Label size={12} tone="muted">
                    {column(status()).length}
                  </Label>
                </If>
              </View>
              <If
                when={folded()}
                else={
                  <Scroll style={grow} scrollbar={false}>
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
                }
              >
                <View
                  style={{
                    width: 34,
                    height: 85,
                    alignItems: "center",
                    justifyContent: "flex-start",
                  }}
                >
                  <Label
                    size={12}
                    line={16}
                    tone="muted"
                    style={{
                      width: 85,
                      textAlign: "left",
                      position: "absolute",
                      top: 34,
                      left: -26,
                      transform: "rotate(90deg)",
                    }}
                  >
                    {`${statusName(status())}  ${column(status()).length}`}
                  </Label>
                </View>
              </If>
            </View>
          );
        }}
      </Each>
    </View>
  );
}
