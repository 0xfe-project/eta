import type {
  BoardTaskView,
  MessageView,
  TaskDraftData,
  TaskDraftStatus,
  TaskResults,
} from "@eta/client-contracts";
import type { JSX } from "nsh";
import { draftStatus } from "@eta/client-contracts";
import { cleanup, signal, View, windowSize } from "nsh";
import {
  Button,
  Caption,
  colors,
  dialogWidth,
  Field,
  grow,
  Label,
  Modal,
  row,
  SmoothScroll,
  textFaces,
  textStyle,
} from "../../components";
import { sendShortcut } from "../../components/eta-editor";
import { showToast } from "../../components/toast";
import { control, space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { problemText } from "../../services/problem-text";
import { createDescription, DescriptionBox } from "../tasks/description-box";
import { Segmented } from "../tasks/segmented";

export function draftTitle(message: MessageView) {
  const title = message.data.title;
  if (typeof title === "string" && title.trim()) return title;
  return message.text.trim() ? message.text : uiText("draftNoTitle");
}

/** The label column of a draft's details. */
const detailLabelWidth = 84;

/** The confirm dialog's height off phones (a phone gives it the whole page). */
const dialogHeight = "85%";

function Detail(props: { label: string; value: string }) {
  return (
    <View style={{ ...row, alignItems: "flex-start", gap: space[8] }}>
      <Label variant="small" tone="muted" style={{ width: detailLabelWidth }}>
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
    <View style={{ gap: space[4] }}>
      <Label variant="small" tone="mutedInk">
        {props.label}
      </Label>
      {props.children}
    </View>
  );
}

/** A task's title as a toast's second line: long ones are cut. */
const TOAST_TITLE_MAX = 80;
function toastTitle(title: string) {
  const line = title.replace(/\s+/g, " ").trim();
  return line.length > TOAST_TITLE_MAX
    ? `${line.slice(0, TOAST_TITLE_MAX - 1).trimEnd()}…`
    : line;
}

/**
 * The form behind a draft's "Edit and confirm": the agent's
 * title, description and status, editable, and where it will run. Closing it in
 * any way leaves the draft as it was; only its confirm button creates the task.
 * Once the task is made the form closes and a toast names it; a confirmation
 * that fails keeps the form, with what was typed, and says why.
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
  const status = signal<TaskDraftStatus>(draftStatus(data()));
  const busy = signal(false);
  /** Why the last confirmation failed, in the host's words. */
  const failure = signal("");
  // The row can become the task's card before the reply comes; the
  // conversation closes the form then, and the reply only adds the toast.
  let open = true;
  cleanup(() => {
    open = false;
  });
  const discarded = () => data().discarded === true;
  const pending = () => !discarded();
  const description = createDescription({
    text: data().description ?? "",
    agents: () =>
      [data().assignee, props.message.agentId].filter(
        (id): id is string => !!id,
      ),
    onSubmit: () => void confirm(),
  });
  const canConfirm = () =>
    pending() &&
    Boolean(title().trim()) &&
    !description.tooLong() &&
    !busy() &&
    host.state().status === "open";
  async function confirm() {
    if (!canConfirm()) return;
    busy.set(true);
    failure.set("");
    let result: TaskResults["confirmDraft"];
    try {
      result = await host.call<TaskResults["confirmDraft"]>(
        "tasks",
        "confirmDraft",
        {
          conversationId: props.message.conversationId,
          messageId: props.message.id,
          edits: {
            title: title().trim(),
            description: description.read(),
            status: status(),
          },
        },
      );
    } catch (problem) {
      busy.set(false);
      failure.set(problemText(problem));
      return;
    }
    busy.set(false);
    const { task } = result;
    showToast({
      title: uiText(
        task.status === "backlog"
          ? "draftBackloggedToast"
          : "draftCreatedToast",
        { number: task.number },
      ),
      body: toastTitle(task.title),
    });
    if (open) props.onClose();
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
    paddingHorizontal: space[12],
    ...textStyle(type("small")),
    borderColor: color().strong,
  };
  return (
    <Modal
      title={uiText("draftConfirmTitle")}
      width={Math.min(dialogWidth.lg, windowSize().width - 32)}
      height={props.phone ? "100%" : dialogHeight}
      phone={props.phone}
      phonePage={props.phone}
      overPhoneNavigation
      modalFocus
      onClose={props.onClose}
    >
      <If when={host.state().status !== "open"}>
        <View
          role="alert"
          style={{ padding: space[8], backgroundColor: color().warningFill }}
        >
          <Label tone="warning">{uiText("connectionLostReconnecting")}</Label>
        </View>
      </If>
      <SmoothScroll
        ref={(node) => queueMicrotask(() => node.focus())}
        role="region"
        focusable
        accessibilityLabel={draftTitle(props.message)}
        style={grow}
      >
        <View
          style={{
            padding: props.phone ? space[16] : space[20],
            gap: space[16],
          }}
        >
          <If
            when={pending()}
            else={
              <View role="alert">
                <Label>
                  {uiText(
                    data().autoHandled === "timeout"
                      ? "draftDiscardedAuto"
                      : "draftDiscarded",
                  )}
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
                style={{ ...input, height: control.lg }}
              />
            </FormRow>
            <FormRow label={uiText("description")}>
              <DescriptionBox
                description={description}
                label={uiText("description")}
                placeholder={uiText("draftNoDescription")}
                phone={props.phone}
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
              <View style={{ gap: space[4] }}>
                <Caption text={uiText("draftExecution")} />
                <Each of={execution()} key={(field) => field.label}>
                  {(field) => (
                    <Detail label={field().label} value={field().value} />
                  )}
                </Each>
              </View>
            </If>
            <If when={data().dependsOn?.length}>
              <View style={{ gap: space[4] }}>
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
      </SmoothScroll>
      <If when={failure()}>
        {(reason) => (
          <View
            role="alert"
            style={{
              paddingVertical: space[8],
              paddingHorizontal: props.phone ? space[16] : space[20],
              backgroundColor: color().redFill,
              flexShrink: 0,
            }}
          >
            <Label variant="small" tone="red">
              {uiText("draftConfirmFailed", { reason: reason() })}
            </Label>
          </View>
        )}
      </If>
      <View
        style={{
          ...row,
          gap: space[8],
          justifyContent: "flex-end",
          paddingVertical: space[12],
          paddingHorizontal: props.phone ? space[16] : space[20],
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
            shortcut={props.phone ? undefined : sendShortcut}
            disabled={!canConfirm() && !busy()}
            busy={busy()}
            onPress={() => void confirm()}
          />
        </If>
      </View>
    </Modal>
  );
}
