import type { Layout } from "../../components";
import { View } from "nsh";
import { colors, grow, row } from "../../components";
import { TaskDetail } from "./task-detail";
import { Tasks } from "./tasks";
/** The task list beside an open task on a tablet. */
const listWidth = 300;

export function TaskWorkspace(props: {
  layout: Layout;
  taskId: string;
  onOpen: (id: string) => void;
  onRelatedTask: (id: string) => void;
  onClose: () => void;
  onCreate: () => void;
}) {
  const c = colors();
  return (
    <View style={{ ...grow, ...row, alignItems: "stretch" }}>
      <View
        style={
          props.taskId && props.layout === "tablet"
            ? {
                width: listWidth,
                flexShrink: 0,
                borderRightWidth: 1,
                borderColor: c().border,
              }
            : { ...grow, display: props.taskId ? "none" : "flex" }
        }
      >
        <Tasks
          layout={props.layout}
          condensed={!!props.taskId && props.layout === "tablet"}
          selected={props.taskId}
          onOpen={props.onOpen}
          onCreate={props.onCreate}
        />
      </View>
      <If when={props.taskId}>
        <Each of={[props.taskId]}>
          {(id) => (
            <TaskDetail
              id={id()}
              layout={props.layout}
              onClose={props.onClose}
              onTask={props.onRelatedTask}
            />
          )}
        </Each>
      </If>
    </View>
  );
}
