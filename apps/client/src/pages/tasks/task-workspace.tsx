import type { Layout } from "../../components";
import { View } from "nsh";
import { colors, fill, grow, row } from "../../components";
import { pushed } from "../../components/motion";
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
  // On a phone the task comes in over the list and goes back off it, the list drawn while it
  // moves (`pushed`); another task taking its place comes in within it. The larger layouts
  // change at once.
  const phone = () => props.layout === "phone";
  const push = pushed();
  /** The task going back off the list, drawn while it goes. */
  let leaving = "";
  /** Runs a change of the open task, then moves it as it changed: done in the same turn, so no
   * frame shows the list or the task without the other. */
  const moving =
    <A extends unknown[]>(change: (...args: A) => void) =>
    (...args: A) => {
      const was = props.taskId;
      change(...args);
      const id = props.taskId;
      if (!phone() || id === was) return;
      if (id && !was) void push.enter();
      else if (id) push.swap("end");
      else {
        leaving = was;
        void push.leave();
      }
    };
  const open = moving((id: string) => props.onOpen(id));
  const related = moving((id: string) => props.onRelatedTask(id));
  const close = moving(() => props.onClose());
  const listHidden = () => !!props.taskId && !push.under();
  const detail = (id: string) => (
    <TaskDetail
      id={id}
      layout={props.layout}
      onClose={close}
      onTask={related}
    />
  );
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
            : { ...grow, display: listHidden() ? "none" : "flex" }
        }
      >
        <Tasks
          layout={props.layout}
          condensed={!!props.taskId && props.layout === "tablet"}
          selected={props.taskId}
          onOpen={open}
          onCreate={props.onCreate}
        />
      </View>
      <If when={props.taskId || (phone() && push.leaving())}>
        <If
          when={phone()}
          else={<Each of={[props.taskId]}>{(id) => detail(id())}</Each>}
        >
          <View
            style={{
              ...fill,
              ...push.style(),
              pointerEvents: push.leaving() ? "none" : "auto",
            }}
          >
            <Each of={[props.taskId || leaving]}>{(id) => detail(id())}</Each>
          </View>
        </If>
      </If>
    </View>
  );
}
