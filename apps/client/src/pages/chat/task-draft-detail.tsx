import type {
  BoardTaskView,
  MessageView,
  TaskDraftData,
  TaskDraftStatus,
  TaskResults,
} from "@eta/client-contracts";
import type { JSX } from "nsh";
import { draftStatus } from "@eta/client-contracts";
import { Scroll, signal, View, windowSize } from "nsh";
import {
  Button,
  Caption,
  colors,
  Field,
  grow,
  Label,
  Modal,
  row,
  textFaces,
  textStyle,
} from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { Segmented } from "../tasks/segmented";

export function draftTitle(message: MessageView) {
  const title = message.data.title;
  if (typeof title === "string" && title.trim()) return title;
  return message.text.trim() ? message.text : uiText("draftNoTitle");
}

function Detail(props: { label: string; value: string }) {
  return (
    <View style={{ ...row, alignItems: "flex-start", gap: 8 }}>
      <Label variant="small" tone="muted" style={{ width: 84 }}>
        {props.label}
      </Label>
      <Label variant="small" style={{ flex: 1 }}>
        {props.value}
      </Label>
    </View>
  );
}

function FormRow(props: { label: string; children: JSX.Element }) {
  return (
    <View style={{ gap: 6 }}>
      <Label variant="small" tone="mutedInk">
        {props.label}
      </Label>
      {props.children}
    </View>
  );
}

/**
 * The form behind a draft's "Edit and confirm", as apps/web's: the agent's
 * title, description and status, editable, and where it will run. Closing it in
 * any way leaves the draft as it was; only its confirm button creates the task.
 */
export function TaskDraftDetail(props: {
  message: MessageView;
  projectName?: string;
  phone: boolean;
  onClose: () => void;
}) {
  const host = useHost();
  const color = colors();
  const type = textFaces();
  const data = () => props.message.data as unknown as Partial<TaskDraftData>;
  const initialTitle =
    typeof props.message.data.title === "string"
      ? props.message.data.title
      : props.message.text;
  const title = signal(initialTitle.trim());
  const description = signal(data().description ?? "");
  const status = signal<TaskDraftStatus>(draftStatus(data()));
  const busy = signal(false);
  const discarded = () => data().discarded === true;
  const pending = () => props.message.kind === "task_draft" && !discarded();
  const canConfirm = () =>
    pending() &&
    Boolean(title().trim()) &&
    !busy() &&
    host.state().status === "open";
  async function confirm() {
    if (!canConfirm()) return;
    busy.set(true);
    const result = await host.action(() =>
      host.call<TaskResults["confirmDraft"]>("tasks", "confirmDraft", {
        conversationId: props.message.conversationId,
        messageId: props.message.id,
        edits: {
          title: title().trim(),
          description: description().trim(),
          status: status(),
        },
      }),
    );
    busy.set(false);
    if (result) props.onClose();
  }
  const executor = () => {
    const id = data().assignee || props.message.agentId;
    if (!id) return undefined;
    const name = host.state().missing.agents
      ? id
      : (host.agent(id)?.name ?? id);
    return data().assignee ? name : uiText("draftProposer", { name });
  };
  const execution = () =>
    [
      { label: uiText("project2"), value: props.projectName },
      {
        label: uiText("draftWorkspace"),
        value:
          data().workspace === "worktree"
            ? uiText("draftWorktree")
            : data().workspace === "local"
              ? uiText("draftLocal")
              : undefined,
      },
      { label: uiText("executor"), value: executor() },
      { label: uiText("draftBase"), value: data().base },
    ].filter((field): field is { label: string; value: string } =>
      Boolean(field.value),
    );
  const taskName = (id: string) => {
    if (host.state().missing.tasks) return id;
    const task =
      host.tasks().find((task) => task.id === id) ??
      host
        .list<BoardTaskView>("tasks", "archived")
        .find((task) => task.id === id);
    return task ? `#${task.number} ${task.title}` : id;
  };
  const input = {
    paddingHorizontal: 10,
    ...textStyle(type("small")),
    borderColor: color().strong,
  };
  return (
    <Modal
      title={uiText("draftConfirmTitle")}
      width={Math.min(560, windowSize().width - 32)}
      height={props.phone ? "100%" : "85%"}
      phone={props.phone}
      phonePage={props.phone}
      overPhoneNavigation
      modalFocus
      onClose={props.onClose}
    >
      <If when={host.state().status !== "open"}>
        <View
          role="alert"
          style={{ padding: 8, backgroundColor: color().amberFill }}
        >
          <Label tone="amber">{uiText("connectionLostReconnecting")}</Label>
        </View>
      </If>
      <Scroll
        ref={(node) => queueMicrotask(() => node.focus())}
        role="region"
        focusable
        accessibilityLabel={draftTitle(props.message)}
        style={grow}
      >
        <View style={{ padding: props.phone ? 16 : 20, gap: 16 }}>
          <If
            when={pending()}
            else={
              <View role="alert">
                <Label>
                  {uiText(discarded() ? "draftDiscarded" : "draftCreated")}
                </Label>
              </View>
            }
          >
            <Label variant="small" tone="muted">
              {uiText("draftConfirmHint")}
            </Label>
            <FormRow label={uiText("title")}>
              <Field
                label={uiText("title")}
                placeholder={uiText("draftNoTitle")}
                value={title()}
                maxLength={200}
                onChange={title.set}
                style={{ ...input, height: 30 }}
              />
            </FormRow>
            <FormRow label={uiText("description")}>
              <Field
                label={uiText("description")}
                placeholder={uiText("draftNoDescription")}
                value={description()}
                multiline
                maxLength={20000}
                onChange={description.set}
                style={{
                  ...input,
                  height: props.phone ? 200 : 240,
                  paddingVertical: 8,
                }}
              />
            </FormRow>
            <FormRow label={uiText("status")}>
              <View style={{ ...row }}>
                <Segmented
                  options={[
                    { value: "todo", label: uiText("draftStartNow") },
                    { value: "backlog", label: uiText("backlog") },
                  ]}
                  value={status()}
                  onChange={status.set}
                />
              </View>
              <Label variant="small" tone="muted">
                {uiText(
                  status() === "backlog" ? "draftToBacklog" : "draftToDo",
                )}
              </Label>
            </FormRow>
            <If when={execution().length}>
              <View style={{ gap: 6 }}>
                <Caption text={uiText("draftExecution")} />
                <Each of={execution()} key={(field) => field.label}>
                  {(field) => (
                    <Detail label={field().label} value={field().value} />
                  )}
                </Each>
              </View>
            </If>
            <If when={data().dependsOn?.length}>
              <View style={{ gap: 6 }}>
                <Caption text={uiText("dependencies")} />
                <Each of={data().dependsOn ?? []} key={(edge) => edge.taskId}>
                  {(edge) => (
                    <Label variant="small">
                      {taskName(edge().taskId)} ·{" "}
                      {uiText(
                        edge().requireDone
                          ? "draftRequireDone"
                          : "draftAllowReview",
                      )}
                    </Label>
                  )}
                </Each>
              </View>
            </If>
            <If when={data().parentId}>
              {(id) => (
                <Detail label={uiText("draftParent")} value={taskName(id())} />
              )}
            </If>
          </If>
        </View>
      </Scroll>
      <View
        style={{
          ...row,
          gap: 8,
          justifyContent: "flex-end",
          paddingVertical: 10,
          paddingHorizontal: props.phone ? 16 : 20,
          borderTopWidth: 1,
          borderColor: color().border,
          flexShrink: 0,
        }}
      >
        <Button label={uiText("cancel")} onPress={props.onClose} />
        <If when={pending()}>
          <Button
            label={
              status() === "backlog"
                ? uiText("newTaskCreate")
                : uiText("confirmAndStart")
            }
            tone="primary"
            disabled={!canConfirm()}
            onPress={() => void confirm()}
          />
        </If>
      </View>
    </Modal>
  );
}
