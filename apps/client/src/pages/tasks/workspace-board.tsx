import type { BoardTaskStatus, BoardTaskView } from "@eta/client-contracts";
import type { Layout } from "../../components";
import type { taskDropZones } from "./drag";
import { Scroll, View } from "nsh";
import { colors, grow, Label, row, SmoothScroll } from "../../components";
import { control, icon, space } from "../../components/tokens";
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

/** Fixed column width for board view. */
const columnWidth = {
  desktop: 240,
  tablet: 160,
};
const headerHeight = 24;

export function TaskWorkspaceBoard(props: {
  layout: Layout;
  items: BoardTaskView[];
  expanded: string[];
  drag: ReturnType<typeof taskDropZones<BoardTaskStatus>>;
  onFoldStatus: (status: string) => void;
  onOpen: (id: string) => void;
}) {
  const c = colors();
  const tablet = () => props.layout === "tablet";
  const boardDrag = props.drag;
  const column = (status: BoardTaskStatus) =>
    props.items.filter((task) => task.status === status);
  const colWidth = tablet() ? columnWidth.tablet : columnWidth.desktop;
  return (
    <Scroll
      horizontal
      style={{ ...grow }}
      contentStyle={{
        paddingHorizontal: tablet() ? space[16] : space[24],
        paddingTop: space[12],
        paddingBottom: tablet() ? space[12] : 0,
        gap: space[8],
        height: "100%",
      }}
    >
      <View
        style={{ ...row, gap: space[8], alignItems: "stretch", height: "100%" }}
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
                  width: folded()
                    ? tablet()
                      ? control.md
                      : space[32]
                    : colWidth,
                  minWidth: 0,
                  backgroundColor: folded()
                    ? tablet()
                      ? c().selected
                      : c().surface
                    : c().canvas,
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
                          paddingTop: space[8],
                          gap: space[8],
                          cursor: "pointer",
                        }
                      : {
                          ...row,
                          gap: tablet() ? space[4] : space[8],
                          height: headerHeight,
                          paddingTop: space[8],
                          paddingLeft: tablet() ? 0 : space[2],
                          cursor: "pointer",
                        }
                  }
                >
                  <TaskGlyph status={status()} size={icon.sm} />
                  <If
                    when={!folded()}
                    else={
                      <>
                        <SideLabel
                          text={
                            tablet()
                              ? `${statusName(status())} ${column(status()).length}`
                              : statusName(status())
                          }
                          tone={tablet() ? "mutedInk" : "muted"}
                        />
                        <If when={!tablet()}>
                          <Label variant="small" tone="muted">
                            {column(status()).length}
                          </Label>
                        </If>
                      </>
                    }
                  >
                    <Label variant="small">{statusName(status())}</Label>
                    <Label variant="small" tone="muted">
                      {column(status()).length}
                    </Label>
                  </If>
                </View>
                <If when={!folded()}>
                  <SmoothScroll
                    style={{ ...grow, marginTop: space[8] }}
                    scrollbar={false}
                  >
                    <View style={{ gap: space[8] }}>
                      <Each of={column(status())} key={(task) => task.id}>
                        {(task) => (
                          <BoardCard
                            task={task()}
                            layout={props.layout}
                            drag={boardDrag}
                            draggable={
                              props.layout === "desktop" && !task().subtasks
                            }
                            onOpen={() => props.onOpen(task().id)}
                          />
                        )}
                      </Each>
                    </View>
                  </SmoothScroll>
                </If>
              </View>
            );
          }}
        </Each>
      </View>
    </Scroll>
  );
}

/** A folded column's name, turned on its side. */
function SideLabel(props: { text: string; tone: "muted" | "mutedInk" }) {
  const length = () => railLength(props.text);
  return (
    <View style={{ width: space[16], height: length() }}>
      <Label
        variant="small"
        tone={props.tone}
        lines={1}
        style={{
          position: "absolute",
          top: length() / 2 - 8,
          left: 8 - length() / 2,
          width: length(),
          transform: "rotate(90deg)",
        }}
      >
        {props.text}
      </Label>
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
