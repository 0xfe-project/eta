import type { BoardTaskDetail } from "@eta/client-contracts";
import { View } from "nsh";
import {
  Button,
  colors,
  Field,
  Label,
  Modal,
  row,
  SmoothScroll,
} from "../../components";
import { control, icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { TaskGlyph } from "./status";

/** The feedback box; the list of tasks waiting on this one, and one of its rows; the dialog's
 * button bar. */
const feedbackHeight = { phone: 104, regular: 92 } as const;
const dependentsHeight = 120;
const dependentHeight = 20;
const footerHeight = 56;

export function TaskReviewDialog(props: {
  decision: "done" | "todo";
  phone: boolean;
  task?: BoardTaskDetail;
  executor?: string;
  feedback: string;
  submitting: boolean;
  onFeedback: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const c = colors();
  return (
    <Modal
      title={
        props.decision === "done"
          ? uiText("acceptAsDone")
          : uiText("sendBackTo", {
              value1: props.executor ?? "the executor",
            })
      }
      phone={props.phone}
      sheet={props.phone}
      overPhoneNavigation={props.phone}
      modalFocus
      dismissible={!props.submitting}
      onClose={props.onClose}
    >
      <View
        style={{
          padding: space[16],
          gap: props.phone && props.decision === "todo" ? space[12] : space[12],
        }}
      >
        <If when={props.phone && props.decision === "todo"}>
          <Label>
            {uiText("sendBackIntro", {
              executor: props.executor ?? uiText("executor"),
            })}
          </Label>
          <View style={{ gap: space[4] }}>
            <Label variant="caption" tone="muted">
              {uiText("comment")}
            </Label>
            <Field
              label={uiText("feedback")}
              multiline
              value={props.feedback}
              onChange={props.onFeedback}
              style={{
                height: feedbackHeight.phone,
                paddingVertical: space[12],
                paddingHorizontal: space[12],
                borderColor: c().strong,
              }}
            />
          </View>
          <Label variant="caption" tone="muted">
            {uiText("sendBackHelper", {
              executor: props.executor ?? uiText("executor"),
            })}
          </Label>
        </If>
        <If when={!props.phone && props.decision === "todo"}>
          <Field
            label={uiText("feedback")}
            placeholder={uiText("whatNeedsToChange")}
            multiline
            value={props.feedback}
            onChange={props.onFeedback}
            style={{ height: feedbackHeight.regular }}
          />
        </If>
        <If when={props.decision === "done"}>
          <View style={{ ...row, gap: space[8] }}>
            <TaskGlyph status="in_review" />
            <Label variant="small" tone="muted">
              {uiText("inReview")}
            </Label>
            <Label variant="small">→</Label>
            <TaskGlyph status="done" />
            <Label variant="small" weight={weight.strong}>
              {uiText("completed")}
            </Label>
          </View>
        </If>
        <If when={!props.phone || props.decision === "done"}>
          <Label>
            {props.decision === "done"
              ? [
                  uiText("acceptTaskDescription", {
                    title: props.task?.title ?? "",
                    number: props.task?.number ?? "",
                  }),
                  props.task?.workspaceMode === "worktree"
                    ? uiText("taskBranchRetained")
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")
              : uiText("theExecutorWillGetYourFeedback")}
          </Label>
        </If>
        <If when={props.decision === "done" && props.task?.dependents?.length}>
          <View
            style={{
              paddingVertical: space[12],
              paddingHorizontal: space[12],
              gap: space[4],
              backgroundColor: c().selected,
            }}
          >
            <Label variant="caption" tone="muted">
              {uiText(
                props.task?.dependents?.length === 1
                  ? "oneTaskWaitsForIt"
                  : "taskDependentCount",
                {
                  count: props.task?.dependents?.length ?? 0,
                },
              )}
            </Label>
            <SmoothScroll style={{ maxHeight: dependentsHeight }}>
              <Each
                of={props.task?.dependents ?? []}
                key={(edge) => edge.taskId}
              >
                {(edge) => (
                  <View
                    style={{
                      ...row,
                      gap: space[8],
                      minHeight: dependentHeight,
                    }}
                  >
                    <TaskGlyph
                      status={edge().status}
                      size={props.phone ? icon.sm : icon.md}
                    />
                    <Label variant="small">
                      {`#${edge().number} ${edge().title}`}
                    </Label>
                  </View>
                )}
              </Each>
            </SmoothScroll>
          </View>
        </If>
      </View>
      <View
        style={{
          ...row,
          paddingHorizontal: space[16],
          height: footerHeight,
          gap: space[8],
          justifyContent: "flex-end",
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        <Button
          label={uiText("cancel")}
          disabled={props.submitting}
          size={control.lg}
          tone="ghost"
          style={props.phone ? { paddingHorizontal: space[12] } : undefined}
          onPress={props.onClose}
        />
        <Button
          label={
            props.decision === "done"
              ? uiText("acceptAsDone")
              : uiText("sendBack")
          }
          size={control.lg}
          tone="primary"
          style={props.phone ? { paddingHorizontal: space[16] } : undefined}
          disabled={props.decision === "todo" && !props.feedback.trim()}
          busy={props.submitting}
          onPress={props.onSubmit}
        />
      </View>
    </Modal>
  );
}
