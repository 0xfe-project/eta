import type { BoardTaskDetail } from "@eta/client-contracts";
import type { TaskDetailState } from "./task-detail-state";
import { TASK_STATUSES } from "@eta/client-contracts";
import { View } from "nsh";
import { Button, colors, Field, Icon, Label, row } from "../../components";
import { uiText } from "../../i18n";
import { relativeTime, useHost } from "../../services/host";
import { statusName, TaskStatus } from "./status";

export function TaskCommentBox(props: { state: TaskDetailState }) {
  const c = colors();
  const { comment, phone, post, posting, updateComment } = props.state;
  return (
    <View
      style={{
        ...row,
        gap: 6,
        borderWidth: 1,
        borderColor: c().strong,
        paddingRight: 6,
      }}
    >
      <Field
        label={uiText("comment")}
        placeholder={uiText("replyARunningTaskReadsIt")}
        value={comment()}
        onChange={updateComment}
        onSubmit={() => void post()}
        style={{ flex: 1, borderWidth: 0 }}
      />
      <Button
        label={phone() ? uiText("send") : uiText("sendComment")}
        icon="arrowUp"
        iconOnly={!phone()}
        tone={phone() ? "primary" : "ghost"}
        size={28}
        disabled={posting() || !comment().trim()}
        onPress={() => void post()}
      />
    </View>
  );
}

export function TaskReviewActions(props: { state: TaskDetailState }) {
  const { executor, phone, review, submitting } = props.state;
  return (
    <View
      style={{
        ...row,
        gap: 8,
        paddingHorizontal: phone() ? 16 : 0,
        paddingVertical: phone() ? 9 : 0,
      }}
    >
      <Button
        label={uiText("sendBack")}
        disabled={!executor() || submitting()}
        size={phone() ? 40 : 26}
        style={{ flex: phone() ? 1 : undefined }}
        onPress={() => review.set("todo")}
      />
      <Button
        label={uiText("acceptAsDone")}
        size={phone() ? 40 : 26}
        tone="primary"
        style={{ flex: phone() ? 1 : undefined }}
        onPress={() => review.set("done")}
      />
    </View>
  );
}

export function TaskFields(detail: {
  item: BoardTaskDetail;
  state: TaskDetailState;
}) {
  const host = useHost();
  const { change, phone, status } = detail.state;
  const item = () => detail.item;
  const executor = () =>
    host.agent(item().assigneeAgentId ?? item().createdBy.agentId);
  const fields = () =>
    [
      ["Executor", executor()?.name ?? "Unassigned"],
      [
        "Belongs to",
        item().ancestors?.at(-1)
          ? `#${item().ancestors!.at(-1)!.number} ${
              item().ancestors!.at(-1)!.title
            }`
          : "",
      ],
      [
        "Workspace",
        item().workspace.mode === "worktree"
          ? "Own git worktree"
          : (item().workspace.path ?? "Project directory"),
      ],
      ["Run", item().runs.at(-1)?.status ?? ""],
      ["Updated", relativeTime(item().updatedAt)],
    ].filter(([, value]) => value);
  return (
    <View style={{ gap: 10 }}>
      <View style={{ ...row, gap: 8, alignItems: "flex-start" }}>
        <Label size={11} tone="muted" style={{ width: 68 }}>
          {uiText("status")}
        </Label>
        <View style={{ gap: 4, flex: 1 }}>
          <View
            role="button"
            accessibilityLabel={uiText("changeStatus")}
            onPress={() => status.set(!status())}
            style={{ ...row, gap: 6, cursor: "pointer" }}
          >
            <TaskStatus task={item()} />
            <Icon name="down" size={9} tone="muted" />
          </View>
          <If when={status()}>
            <View style={{ gap: 4 }}>
              <Each of={TASK_STATUSES}>
                {(entry) => (
                  <Button
                    label={statusName(entry())}
                    selected={entry() === item().status}
                    onPress={() => change(entry())}
                  />
                )}
              </Each>
            </View>
          </If>
        </View>
      </View>
      <Each of={fields()} key={(field) => field[0]}>
        {(field) => (
          <View style={{ ...row, alignItems: "flex-start", gap: 8 }}>
            <Label size={11} tone="muted" style={{ width: 68 }}>
              {field()[0]}
            </Label>
            <Label size={12} style={{ flex: 1 }} weight={500}>
              {field()[1]}
            </Label>
          </View>
        )}
      </Each>
      <If
        when={
          item().status === "in_review" && !item().children?.length && !phone()
        }
      >
        <TaskReviewActions state={detail.state} />
      </If>
    </View>
  );
}
