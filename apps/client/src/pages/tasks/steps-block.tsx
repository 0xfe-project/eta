import type { TaskStepStatus, TaskStepView } from "@eta/client-contracts";
import { View } from "nsh";
import { grow, Label, row, SmoothScroll } from "../../components";
import { icon, space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { TaskGlyph } from "./status";
import { stepRows } from "./task-steps";

const statusText: Record<TaskStepStatus, Parameters<typeof uiText>[0]> = {
  pending: "pending",
  in_progress: "taskInProgress",
  completed: "taskCompleted",
  cancelled: "taskCancelled",
};

/**
 * The plan the task's executor keeps in its latest run, read only; nothing at all when it made
 * none. It takes what is left of the rail under the other rows, and a longer plan scrolls inside.
 */
export function TaskStepsBlock(props: { taskId: string }) {
  const host = useHost();
  const plan = () =>
    stepRows(host.section<TaskStepView[]>(`tasks.${props.taskId}`, "steps"));
  return (
    <If when={plan()}>
      <View style={{ ...grow, gap: space[4] }}>
        <Label variant="caption" tone="muted">
          {uiText("stepCount", {
            completed: plan()!.completed,
            total: plan()!.total,
          })}
        </Label>
        <SmoothScroll style={grow}>
          <Each of={plan()!.rows} key={(step) => step.id}>
            {(step) => (
              <View
                role="text"
                accessible
                accessibilityLabel={`${uiText(statusText[step().status])} · ${step().content}`}
                style={{ ...row, gap: space[8], minHeight: space[24] }}
              >
                <TaskGlyph status={step().glyph} size={icon.sm} />
                <Label
                  variant="small"
                  tone={step().status === "cancelled" ? "muted" : "ink"}
                  lines={1}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  {step().content}
                </Label>
              </View>
            )}
          </Each>
        </SmoothScroll>
      </View>
    </If>
  );
}
