import type { BoardTaskDetail } from "@eta/client-contracts";
import type { Layout } from "../../components";
import type { TaskDetailState } from "./task-detail-state";
import { TASK_STATUSES } from "@eta/client-contracts";
import { untracked, View } from "nsh";
import {
  Button,
  colors,
  dialogWidth,
  Field,
  grow,
  Icon,
  Label,
  Modal,
  row,
  SmoothScroll,
} from "../../components";
import { sendShortcut } from "../../components/eta-editor";
import { CloseButton } from "../../components/navigation-buttons";
import { control, icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { createDescription, DescriptionBox } from "./description-box";
import { TaskReviewDialog } from "./review-dialog";
import { TaskRunLog } from "./run-log";
import { statusHint, statusName, TaskGlyph } from "./status";

/** The status sheet's check column; the task picker's height (off phones, and as a phone's
 * sheet); a dialog's button bar. */
const checkColumnWidth = 16;
const pickerHeight = 440;
const pickerSheetHeight = "66%";
const footerHeight = 56;

export function TaskDetailDialogs(props: {
  id: string;
  layout: Layout;
  onClose: () => void;
  state: TaskDetailState;
}) {
  const host = useHost();
  const c = colors();
  const {
    activeArchiveTargets,
    archive,
    cancelling,
    change,
    editing,
    executor,
    feedback,
    log,
    mutate,
    panel,
    phone,
    replacing,
    resolveBlock,
    review,
    search,
    status,
    statusError,
    stop,
    submitting,
    submitReview,
    task,
    updateFeedback,
  } = props.state;
  const archiveTitle = () =>
    activeArchiveTargets().length === 1
      ? uiText("isRunningArchivingStopsItsRun", {
          number: activeArchiveTargets()[0]!.number,
        })
      : activeArchiveTargets().length > 1
        ? uiText("archivingStopsOngoingTaskRunsArchive")
        : uiText("archiveTask");
  const archiveBody = () =>
    activeArchiveTargets().length === 1
      ? uiText("theRunStopsTheTaskStays", {
          status: statusName(activeArchiveTargets()[0]!.status),
        })
      : activeArchiveTargets().length
        ? uiText("theRunsStopAndTheTasks")
        : uiText("thisWillPutTheTaskAnd");
  const archiveLabel = () =>
    activeArchiveTargets().length
      ? uiText("stopAndArchive")
      : uiText("archive");
  function archiveTask() {
    const stopRuns = activeArchiveTargets().length > 0;
    void mutate(async () => {
      await host.call("tasks", "archive", { taskId: props.id, stopRuns });
      props.onClose();
    });
  }
  return (
    <>
      <If when={phone() && status()}>
        <Modal
          title={uiText("changeStatus")}
          phone
          sheet
          overPhoneNavigation
          onClose={() => status.set(false)}
        >
          <View style={{ paddingTop: space[4], paddingBottom: space[20] }}>
            <Each of={TASK_STATUSES}>
              {(entry) => (
                <>
                  <If when={entry() === "blocked"}>
                    <View
                      style={{
                        height: 1,
                        marginVertical: space[4],
                        backgroundColor: c().border,
                      }}
                    />
                  </If>
                  <View
                    role="button"
                    accessibilityLabel={statusName(entry())}
                    accessibilityState={{
                      selected: entry() === task()?.status,
                      disabled: submitting(),
                    }}
                    onPress={() => {
                      if (!submitting()) change(entry());
                    }}
                    activeStyle={{ backgroundColor: c().selected }}
                    style={{
                      ...row,
                      alignItems: "flex-start",
                      paddingVertical: space[12],
                      paddingHorizontal: space[16],
                      gap: space[8],
                      backgroundColor:
                        entry() === task()?.status ? c().selected : undefined,
                    }}
                  >
                    <View
                      style={{ ...row, width: space[12], height: space[20] }}
                    >
                      <TaskGlyph status={entry()} size={icon.sm} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Label>{statusName(entry())}</Label>
                      <Label variant="small" tone="muted">
                        {statusHint(entry(), task()?.dependents?.length ?? 0)}
                      </Label>
                    </View>
                    <View
                      style={{
                        ...row,
                        justifyContent: "center",
                        width: checkColumnWidth,
                        height: space[16],
                      }}
                    >
                      <If when={entry() === task()?.status}>
                        <Icon name="check" size={icon.sm} />
                      </If>
                    </View>
                  </View>
                </>
              )}
            </Each>
            <If when={statusError()}>
              {(message) => (
                <Label
                  variant="small"
                  tone="red"
                  style={{ paddingTop: space[8], paddingHorizontal: space[16] }}
                >
                  {message()}
                </Label>
              )}
            </If>
          </View>
        </Modal>
      </If>
      <If when={replacing()}>
        <Modal
          title={uiText("waitForAnotherTask2")}
          phone={phone()}
          sheet={phone()}
          height={phone() ? pickerSheetHeight : pickerHeight}
          onClose={() => replacing.set(false)}
        >
          <View style={{ ...grow, padding: space[16], gap: space[8] }}>
            <Field
              label={uiText("findATask")}
              placeholder={uiText("findATask")}
              value={search()}
              onChange={search.set}
            />
            <SmoothScroll style={grow}>
              <Each
                of={host
                  .tasks()
                  .filter(
                    (item) =>
                      item.id !== props.id &&
                      item.status !== "cancelled" &&
                      !item.archivedAt &&
                      !task()?.dependsOn?.some(
                        (edge) => edge.taskId === item.id,
                      ) &&
                      (item.title
                        .toLowerCase()
                        .includes(search().trim().toLowerCase()) ||
                        `#${item.number}`.includes(search().trim())),
                  )}
                key={(item) => item.id}
              >
                {(item) => (
                  <Button
                    label={`#${item().number} ${item().title}`}
                    size={phone() ? control.touch : control.lg}
                    end="right"
                    tone="ghost"
                    disabled={submitting()}
                    onPress={() => resolveBlock(item().id)}
                  />
                )}
              </Each>
            </SmoothScroll>
          </View>
        </Modal>
      </If>
      <If when={cancelling()}>
        <Modal
          title={uiText("cancelThisTask2")}
          phone={phone()}
          sheet={phone()}
          onClose={() => cancelling.set(false)}
        >
          <View style={{ padding: space[16], gap: space[8] }}>
            <Label>{uiText("thisWillCancelTheTaskAnd")}</Label>
            <Button
              label={uiText("cancelTask")}
              tone="danger"
              disabled={submitting()}
              onPress={() => change("cancelled")}
            />
          </View>
        </Modal>
      </If>
      <If when={review()}>
        {(next) => (
          <TaskReviewDialog
            decision={next()}
            task={task()}
            executor={executor()?.name}
            phone={phone()}
            feedback={feedback()}
            submitting={submitting()}
            onFeedback={updateFeedback}
            onClose={() => review.set(undefined)}
            onSubmit={() => submitReview(next())}
          />
        )}
      </If>
      <If when={panel() && task()}>
        <Modal
          title={uiText("taskDetails")}
          side
          width={dialogWidth.sm}
          height="100%"
          hideHeader
          overPhoneNavigation
          onClose={() => panel.set(false)}
        >
          <TaskContextPanel item={task()!} onClose={() => panel.set(false)} />
        </Modal>
      </If>
      <If when={editing()}>
        <Modal
          title={uiText("editTask")}
          phone={phone()}
          sheet={phone()}
          onClose={() => editing.set(false)}
        >
          <EditTask
            state={props.state}
            id={props.id}
            phone={phone()}
            onClose={() => editing.set(false)}
          />
        </Modal>
      </If>
      <If when={archive()}>
        <Modal
          title={archiveTitle()}
          phone={phone()}
          sheet={phone()}
          hideHeader={phone()}
          compact={!phone()}
          titleWeight={weight.regular}
          panelStyle={
            props.layout === "desktop"
              ? { position: "absolute", top: 340 }
              : undefined
          }
          overPhoneNavigation
          onClose={() => archive.set(false)}
        >
          <If
            when={phone()}
            else={
              <View style={{ paddingTop: space[8] }}>
                <Label variant="small" tone="muted">
                  {archiveBody()}
                </Label>
                <View
                  style={{
                    ...row,
                    justifyContent: "flex-end",
                    gap: space[8],
                    paddingTop: space[20],
                  }}
                >
                  <Button
                    label={uiText("keepIt")}
                    size={control.md}
                    onPress={() => archive.set(false)}
                  />
                  <Button
                    label={archiveLabel()}
                    size={control.md}
                    tone="primary"
                    disabled={submitting()}
                    onPress={archiveTask}
                  />
                </View>
              </View>
            }
          >
            <View
              style={{
                ...row,
                alignItems: "flex-start",
                gap: space[8],
                paddingVertical: space[8],
                paddingLeft: space[16],
                paddingRight: space[8],
                borderBottomWidth: 1,
                borderColor: c().border,
              }}
            >
              <Label
                weight={weight.strong}
                style={{ flex: 1, minWidth: 0, paddingTop: space[8] }}
              >
                {archiveTitle()}
              </Label>
              <CloseButton
                size={control.lg}
                iconSize={icon.md}
                onPress={() => archive.set(false)}
              />
            </View>
            <View style={{ padding: space[16] }}>
              <Label>{archiveBody()}</Label>
            </View>
            <View
              style={{
                ...row,
                justifyContent: "flex-end",
                height: footerHeight,
                gap: space[8],
                paddingHorizontal: space[16],
                borderTopWidth: 1,
                borderColor: c().border,
              }}
            >
              <Button
                label={uiText("keepIt")}
                tone="ghost"
                size={control.lg}
                labelVariant="small"
                style={{ paddingHorizontal: space[12] }}
                onPress={() => archive.set(false)}
              />
              <Button
                label={archiveLabel()}
                tone="primary"
                size={control.lg}
                labelVariant="small"
                style={{ paddingHorizontal: space[16] }}
                disabled={submitting()}
                onPress={archiveTask}
              />
            </View>
          </If>
        </Modal>
      </If>
      <If when={log()}>
        {(run) => (
          <TaskRunLog
            run={task()?.runs.find((entry) => entry.id === run().id) ?? run()}
            index={
              task()?.runs.findIndex((entry) => entry.id === run().id) ?? 0
            }
            executor={
              host.agent(run().agentId)?.name ?? executor()?.name ?? "Executor"
            }
            layout={props.layout}
            agentId={run().agentId ?? executor()?.id ?? ""}
            nextRunAt={
              task()
                ?.runs.slice(
                  (task()?.runs.findIndex((r) => r.id === run().id) ?? -1) + 1,
                )
                .find((r) => r.sessionId && r.sessionId === run().sessionId)
                ?.startedAt ?? undefined
            }
            onStop={() => stop(run())}
            stopping={submitting()}
            onClose={() => log.set(undefined)}
          />
        )}
      </If>
    </>
  );
}

/** The tablet task page's drawer: who works on the task and the group it came from. */
function TaskContextPanel(props: {
  item: BoardTaskDetail;
  onClose: () => void;
}) {
  const c = colors();
  const host = useHost();
  const executor = () =>
    props.item.assigneeAgentId ?? props.item.createdBy.agentId;
  const name = (id: string | null | undefined) =>
    (id ? host.agent(id)?.name : undefined) ?? uiText("taskMe");
  const members = () => [
    [name(executor()), uiText("executor")],
    ...(props.item.createdBy.agentId === executor()
      ? []
      : [[name(props.item.createdBy.agentId), uiText("taskCreatedTheTask")]]),
  ];
  const group = () =>
    host
      .conversations()
      .find(
        (conversation) => conversation.id === props.item.originConversationId,
      )?.name;
  return (
    <View style={grow}>
      <View
        style={{
          ...row,
          justifyContent: "space-between",
          height: space[40],
          paddingLeft: space[12],
          paddingRight: space[8],
          borderBottomWidth: 1,
          borderColor: c().border,
          backgroundColor: c().surface,
        }}
      >
        <View
          role="tablist"
          style={{
            ...row,
            gap: space[2],
            padding: space[2],
            backgroundColor: c().selected,
          }}
        >
          <View
            role="tab"
            accessibilityLabel={uiText("taskContext")}
            accessibilityState={{ selected: true }}
            style={{
              ...row,
              height: space[24],
              paddingHorizontal: space[12],
              gap: space[4],
              backgroundColor: c().canvas,
            }}
          >
            <Icon name="context" size={icon.sm} />
            <Label variant="small">{uiText("taskContext")}</Label>
          </View>
        </View>
        <CloseButton onPress={props.onClose} />
      </View>
      <View style={{ padding: space[12], gap: space[12] }}>
        <Label
          variant="caption"
          tone="muted"
          tracking="caps"
          style={{ textTransform: "uppercase" }}
        >
          {uiText("members")}
        </Label>
        <View style={{ borderTopWidth: 1, borderColor: c().border }}>
          <Each of={members()} key={(member) => member.join()}>
            {(member) => (
              <View
                style={{
                  ...row,
                  justifyContent: "space-between",
                  paddingVertical: space[12],
                  borderBottomWidth: 1,
                  borderColor: c().border,
                }}
              >
                <Label variant="small">{member()[0]}</Label>
                <Label variant="small" tone="muted">
                  {member()[1]}
                </Label>
              </View>
            )}
          </Each>
        </View>
        <If when={group()}>
          <Label
            variant="caption"
            tone="muted"
            tracking="caps"
            style={{ textTransform: "uppercase", paddingTop: space[8] }}
          >
            {uiText("taskGroup")}
          </Label>
          <Label variant="small">{group()}</Label>
        </If>
      </View>
    </View>
  );
}

/** The task's title and description edited together (the panel's ⋯ › Edit). */
function EditTask(props: {
  state: TaskDetailState;
  id: string;
  phone: boolean;
  onClose: () => void;
}) {
  const host = useHost();
  const { editDescription, editTitle, mutate, submitting } = props.state;
  const description = createDescription({
    text: untracked(() => editDescription()),
    onSubmit: () => save(),
  });
  const ready = () =>
    !submitting() && !!editTitle().trim() && !description.tooLong();
  function save() {
    if (!ready()) return;
    void mutate(async () => {
      await host.call("tasks", "update", {
        taskId: props.id,
        title: editTitle().trim(),
        description: description.read(),
      });
      props.onClose();
    });
  }
  return (
    <View style={{ padding: space[16], gap: space[8] }}>
      <Field
        label={uiText("taskTitle")}
        value={editTitle()}
        onChange={editTitle.set}
      />
      <DescriptionBox
        description={description}
        label={uiText("taskDescription")}
        phone={props.phone}
      />
      <View style={{ ...row, justifyContent: "flex-end", gap: space[8] }}>
        <Button label={uiText("cancel")} onPress={props.onClose} />
        <Button
          label={uiText("saveTask")}
          tone="primary"
          shortcut={props.phone ? undefined : sendShortcut}
          disabled={!ready()}
          onPress={save}
        />
      </View>
    </View>
  );
}
