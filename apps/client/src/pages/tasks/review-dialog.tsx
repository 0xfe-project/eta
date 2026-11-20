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
      <View style={{ padding: 16, gap: 14 }}>
        <If when={props.decision === "todo"}>
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
            <Label size={13} tone="muted">
              {uiText("inReview")}
            </Label>
            <Label size={13}>→</Label>
            <TaskGlyph status="done" />
            <Label size={13} weight={600}>
              {uiText("completed")}
            </Label>
          </View>
        </If>
        <Label size={13} line={20}>
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
        <If when={props.decision === "done" && props.task?.dependents?.length}>
          <View style={{ padding: 12, gap: 6, backgroundColor: c().selected }}>
            <Label size={11} tone="muted">
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
                  <View style={{ ...row, gap: 7, minHeight: 18 }}>
                    <TaskGlyph status={edge().status} size={14} />
                    <Label
                      size={13}
                    >{`#${edge().number} ${edge().title}`}</Label>
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
