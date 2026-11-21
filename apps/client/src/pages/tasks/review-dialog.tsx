import type { BoardTaskDetail } from "@eta/client-contracts";
import { Scroll, View } from "nsh";
import { Button, colors, Field, Label, Modal, row } from "../../components";
import { uiText } from "../../i18n";
import { TaskGlyph } from "./status";

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
          padding: 16,
          gap: props.phone && props.decision === "todo" ? 12 : 14,
        }}
      >
        <If when={props.phone && props.decision === "todo"}>
          <Label>
            {uiText("sendBackIntro", {
              executor: props.executor ?? uiText("executor"),
            })}
          </Label>
          <View style={{ gap: 6 }}>
            <Label variant="caption" tone="muted">
              {uiText("comment")}
            </Label>
            <Field
              label={uiText("feedback")}
              multiline
              value={props.feedback}
              onChange={props.onFeedback}
              style={{
                height: 104,
                paddingVertical: 10,
                paddingHorizontal: 12,
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
            style={{ height: 92 }}
          />
        </If>
        <If when={props.decision === "done"}>
          <View style={{ ...row, gap: 8 }}>
            <TaskGlyph status="in_review" />
            <Label variant="small" tone="muted">
              {uiText("inReview")}
            </Label>
            <Label variant="small">→</Label>
            <TaskGlyph status="done" />
            <Label variant="small" weight={600}>
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
              paddingVertical: props.phone ? 10 : 12,
              paddingHorizontal: 12,
              gap: props.phone ? 4 : 6,
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
            <Scroll style={{ maxHeight: 120 }}>
              <Each
                of={props.task?.dependents ?? []}
                key={(edge) => edge.taskId}
              >
                {(edge) => (
                  <View
                    style={{ ...row, gap: props.phone ? 8 : 7, minHeight: 18 }}
                  >
                    <TaskGlyph
                      status={edge().status}
                      size={props.phone ? 12 : 14}
                    />
                    <Label variant="small">
                      {`#${edge().number} ${edge().title}`}
                    </Label>
                  </View>
                )}
              </Each>
            </Scroll>
          </View>
        </If>
      </View>
      <View
        style={{
          ...row,
          paddingHorizontal: 16,
          height: 56,
          gap: 8,
          justifyContent: "flex-end",
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        <Button
          label={uiText("cancel")}
          disabled={props.submitting}
          size={32}
          tone="ghost"
          style={props.phone ? { paddingHorizontal: 12 } : undefined}
          onPress={props.onClose}
        />
        <Button
          label={
            props.decision === "done"
              ? uiText("acceptAsDone")
              : uiText("sendBack")
          }
          size={32}
          tone="primary"
          style={props.phone ? { paddingHorizontal: 14 } : undefined}
          disabled={
            props.submitting ||
            (props.decision === "todo" && !props.feedback.trim())
          }
          onPress={props.onSubmit}
        />
      </View>
    </Modal>
  );
}
