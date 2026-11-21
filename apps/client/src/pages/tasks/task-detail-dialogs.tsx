import type { BoardTaskDetail } from "@eta/client-contracts";
import type { Layout } from "../../components";
import type { TaskDetailState } from "./task-detail-state";
import { TASK_STATUSES } from "@eta/client-contracts";
import { Scroll, View } from "nsh";
import {
  Button,
  colors,
  Field,
  grow,
  Icon,
  Label,
  Modal,
  row,
} from "../../components";
import { CloseButton } from "../../components/navigation-buttons";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { TaskReviewDialog } from "./review-dialog";
import { TaskRunLog } from "./run-log";
import { statusHint, statusName, TaskGlyph } from "./status";

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
    editDescription,
    editTitle,
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
          <View style={{ paddingTop: 4, paddingBottom: 20 }}>
            <Each of={TASK_STATUSES}>
              {(entry) => (
                <>
                  <If when={entry() === "blocked"}>
                    <View
                      style={{
                        height: 1,
                        marginVertical: 4,
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
                      paddingVertical: 10,
                      paddingHorizontal: 16,
                      gap: 8,
                      backgroundColor:
                        entry() === task()?.status ? c().selected : undefined,
                    }}
                  >
                    <View style={{ ...row, width: 12, height: 20 }}>
                      <TaskGlyph status={entry()} size={12} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Label size={14} line={20}>
                        {statusName(entry())}
                      </Label>
                      <Label size={12} line={16} tone="muted">
                        {statusHint(entry(), task()?.dependents?.length ?? 0)}
                      </Label>
                    </View>
                    <View
                      style={{
                        ...row,
                        justifyContent: "center",
                        width: 14,
                        height: 16,
                      }}
                    >
                      <If when={entry() === task()?.status}>
                        <Icon name="check" size={12} />
                      </If>
                    </View>
                  </View>
                </>
              )}
            </Each>
            <If when={statusError()}>
              {(message) => (
                <Label
                  size={12}
                  line={16}
                  tone="red"
                  style={{ paddingTop: 8, paddingHorizontal: 16 }}
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
          height={phone() ? "66%" : 440}
          onClose={() => replacing.set(false)}
        >
          <View style={{ ...grow, padding: 16, gap: 8 }}>
            <Field
              label={uiText("findATask")}
              placeholder={uiText("findATask")}
              value={search()}
              onChange={search.set}
            />
            <Scroll style={grow}>
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
                    size={38}
                    end="right"
                    tone="ghost"
                    disabled={submitting()}
                    onPress={() => resolveBlock(item().id)}
                  />
                )}
              </Each>
            </Scroll>
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
          <View style={{ padding: 16, gap: 10 }}>
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
          width={360}
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
          <View style={{ padding: 16, gap: 10 }}>
            <Field
              label={uiText("taskTitle")}
              value={editTitle()}
              onChange={editTitle.set}
            />
            <Field
              label={uiText("taskDescription")}
              value={editDescription()}
              onChange={editDescription.set}
              multiline
              style={{ height: 136 }}
            />
            <View style={{ ...row, justifyContent: "flex-end", gap: 8 }}>
              <Button
                label={uiText("cancel")}
                onPress={() => editing.set(false)}
              />
              <Button
                label={uiText("saveTask")}
                tone="primary"
                disabled={submitting() || !editTitle().trim()}
                onPress={() =>
                  void mutate(async () => {
                    await host.call("tasks", "update", {
                      taskId: props.id,
                      title: editTitle().trim(),
                      description: editDescription(),
                    });
                    editing.set(false);
                  })
                }
              />
            </View>
          </View>
        </Modal>
      </If>
      <If when={archive()}>
        <Modal
          title={archiveTitle()}
          phone={phone()}
          sheet={phone()}
          hideHeader={phone()}
          compact={!phone()}
          titleWeight={500}
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
              <View style={{ paddingTop: 6 }}>
                <Label size={12} line={18} tone="muted">
                  {archiveBody()}
                </Label>
                <View
                  style={{
                    ...row,
                    justifyContent: "flex-end",
                    gap: 8,
                    paddingTop: 20,
                  }}
                >
                  <Button
                    label={uiText("keepIt")}
                    size={28}
                    onPress={() => archive.set(false)}
                  />
                  <Button
                    label={archiveLabel()}
                    size={28}
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
                gap: 8,
                paddingVertical: 8,
                paddingLeft: 16,
                paddingRight: 8,
                borderBottomWidth: 1,
                borderColor: c().border,
              }}
            >
              <Label
                size={14}
                line={20}
                weight={600}
                style={{ flex: 1, minWidth: 0, paddingTop: 6 }}
              >
                {archiveTitle()}
              </Label>
              <CloseButton
                size={32}
                iconSize={16}
                onPress={() => archive.set(false)}
              />
            </View>
            <View style={{ padding: 16 }}>
              <Label size={14} line={20}>
                {archiveBody()}
              </Label>
            </View>
            <View
              style={{
                ...row,
                justifyContent: "flex-end",
                height: 56,
                gap: 8,
                paddingHorizontal: 16,
                borderTopWidth: 1,
                borderColor: c().border,
              }}
            >
              <Button
                label={uiText("keepIt")}
                tone="ghost"
                size={32}
                labelSize={13}
                style={{ paddingHorizontal: 12 }}
                onPress={() => archive.set(false)}
              />
              <Button
                label={archiveLabel()}
                tone="primary"
                size={32}
                labelSize={13}
                style={{ paddingHorizontal: 14 }}
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
  const caption = {
    letterSpacing: 0.8,
    textTransform: "uppercase",
  } as const;
  return (
    <View style={grow}>
      <View
        style={{
          ...row,
          justifyContent: "space-between",
          height: 40,
          paddingLeft: 10,
          paddingRight: 8,
          borderBottomWidth: 1,
          borderColor: c().border,
          backgroundColor: c().surface,
        }}
      >
        <View
          role="tablist"
          style={{ ...row, gap: 2, padding: 2, backgroundColor: c().selected }}
        >
          <View
            role="tab"
            accessibilityLabel={uiText("taskContext")}
            accessibilityState={{ selected: true }}
            style={{
              ...row,
              height: 24,
              paddingHorizontal: 10,
              gap: 6,
              backgroundColor: c().canvas,
            }}
          >
            <Icon name="context" size={12} />
            <Label size={11} line={16}>
              {uiText("taskContext")}
            </Label>
          </View>
        </View>
        <CloseButton onPress={props.onClose} />
      </View>
      <View style={{ padding: 12, gap: 12 }}>
        <Label size={10} line={12} tone="muted" style={caption}>
          {uiText("members")}
        </Label>
        <View style={{ borderTopWidth: 1, borderColor: c().border }}>
          <Each of={members()} key={(member) => member.join()}>
            {(member) => (
              <View
                style={{
                  ...row,
                  justifyContent: "space-between",
                  paddingVertical: 10,
                  borderBottomWidth: 1,
                  borderColor: c().border,
                }}
              >
                <Label size={12} line={16}>
                  {member()[0]}
                </Label>
                <Label size={12} line={16} tone="muted">
                  {member()[1]}
                </Label>
              </View>
            )}
          </Each>
        </View>
        <If when={group()}>
          <Label
            size={10}
            line={12}
            tone="muted"
            style={{ ...caption, paddingTop: 8 }}
          >
            {uiText("taskGroup")}
          </Label>
          <Label size={12} line={16}>
            {group()}
          </Label>
        </If>
      </View>
    </View>
  );
}
