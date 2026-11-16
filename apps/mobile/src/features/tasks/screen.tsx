import type {
  BoardTaskStatus,
  TaskDetailSections,
  TaskRunView,
} from "@eta/client-contracts";
import type { ScrollRef } from "nsh";
import type { TaskDetail } from "./format";
import { computed, effect, Scroll, signal, Text, View } from "nsh";
import { boardLoaded, boardTasks } from "../../app/lists";
import { retry, wire } from "../../app/session";
import { t } from "../../i18n";
import { nav } from "../../nav/stack";
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/Markdown";
import { Header, Page } from "../../ui/Page";
import { ConfirmSheet, Sheet } from "../../ui/Sheet";
import { Empty, Failed, Loading } from "../../ui/States";
import { statusClasses, statusTone } from "../../ui/status-tone";
import { StatusPill, TaskStatusIcon } from "../../ui/StatusIcon";
import { toast } from "../../ui/toast";
import { call, useTarget } from "../../wire/target";
import { Composer, OutgoingComments, useComments } from "./composer";
import { openEditTask } from "./edit";
import {
  actorName,
  blockedByCancel,
  cancelImpact,
  cancelledWith,
  failure,
  isActive,
  queueReason,
  runActor,
  statusLabel,
  waitingNumbers,
} from "./format";
import { openRunLog, openRuns } from "./runs";
import { LinkSheet, PropertiesSheet, SheetOption, StatusSheet } from "./sheets";
import { openQuestion, Thread } from "./thread";

/** "11-08": the day a task was archived. */
const archiveDate = (at: number): string => {
  const date = new Date(at);
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, "0")}`;
};

const showError = (error: unknown) =>
  toast(t("common.failed", { message: failure(error) }));

/** The one question a blocked task waits on, and the way to the box to answer it. */
function Question(props: { task: () => TaskDetail; onReply: () => void }) {
  return (
    <If when={openQuestion(props.task())}>
      {(question) => (
        <View class="shrink-0 gap-[6px] bg-muted px-4 py-3">
          <Text class="text-sm leading-[18px] text-muted-foreground">
            <Text class="text-foreground">{actorName(question().actor)}</Text>{" "}
            {t("tasks.waiting")}
          </Text>
          <Markdown text={question().body ?? ""} />
          <View class="flex-row justify-end">
            <View
              role="button"
              testID="task-reply"
              onPress={props.onReply}
              class="h-8 flex-row items-center px-2 active:opacity-60"
            >
              <Text class="text-md leading-4 text-foreground">
                {t("tasks.reply")}
              </Text>
            </View>
          </View>
        </View>
      )}
    </If>
  );
}

/** One run that has not ended: who, doing what, and stopping it. */
function LiveRun(props: { task: () => TaskDetail; run: TaskRunView }) {
  const run = () => props.run;
  const queued = () => run().status === "queued";
  const who = () => actorName(runActor(props.task(), run()));
  const doing = () => {
    if (queued()) return t("tasks.live.queued", { name: who() });
    if (run().status === "starting")
      return t("tasks.live.starting", { name: who() });
    return run().agentId === null
      ? t("tasks.live.working", { name: who() })
      : t("tasks.live.answering", { name: who() });
  };
  const why = () => {
    const code = run().queueReason;
    return queued() && code !== null
      ? queueReason(code, run().machineId, waitingNumbers(props.task()))
      : undefined;
  };
  const stop = () => {
    call("tasks", "interrupt", {
      taskId: props.task().id,
      runId: run().id,
    }).catch(showError);
  };
  return (
    <View class="min-h-8 flex-row items-center gap-[6px]">
      <Icon
        name={queued() ? "clock" : "spinner"}
        size={14}
        color={queued() ? "muted-foreground" : "foreground"}
      />
      <Text class="grow basis-0 text-sm leading-[18px] text-foreground">
        {doing()}
        <If when={why() !== undefined}>
          <Text class="text-muted-foreground"> · {why()}</Text>
        </If>
      </Text>
      <If when={!queued() && run().sessionId !== null}>
        <Text
          onPress={() => openRunLog(props.task().id, run().id)}
          class="text-sm leading-4 text-muted-foreground"
        >
          {t("tasks.log.title")}
        </Text>
      </If>
      <View
        role="button"
        accessibilityLabel={t("tasks.stop")}
        onPress={stop}
        class="h-8 flex-row items-center gap-1 px-1 active:opacity-60"
      >
        <Icon name="stop" size={12} />
        <Text class="text-sm leading-4 text-foreground">{t("tasks.stop")}</Text>
      </View>
    </View>
  );
}

function LiveRuns(props: { task: () => TaskDetail }) {
  const active = () => props.task().runs.filter((run) => isActive(run.status));
  return (
    <If when={active().length > 0}>
      <View class="shrink-0 border-t border-border px-4 py-[6px]">
        <Each of={active()} key={(run) => run.id}>
          {(run) => <LiveRun task={props.task} run={run()} />}
        </Each>
      </View>
    </If>
  );
}

type Open =
  | "status"
  | "properties"
  | "more"
  | "link"
  | "delete"
  | "cancelTree"
  | "archive";

function TaskView(props: { task: () => TaskDetail }) {
  const task = props.task;
  const sheet = signal<Open | undefined>(undefined);
  const comments = useComments(task);
  let focusBox = (): void => undefined;
  let scroll: ScrollRef | undefined;
  const close = () => sheet.set(undefined);

  // A thread opens on its latest word, next to the box to answer it.
  effect(() => {
    void task().activity.length;
    void comments.waiting().length;
    setTimeout(() => scroll?.scrollToEnd({ animated: false }), 0);
  });

  // As the host derives it: from the subtasks that are not cancelled.
  const autoHint = () => {
    const count = task().subtasks?.total ?? 0;
    return count === 1
      ? t("tasks.status.autoHintOne")
      : t("tasks.status.autoHint", { count });
  };
  // A parent cannot be moved by the status sheet, but it can be called off with the work under it.
  const cancelTree = (): void => {
    close();
    call("tasks", "update", { taskId: task().id, status: "cancelled" }).catch(
      showError,
    );
  };
  // The count is the only thing between a press and a whole tree cancelled: until the board is
  // here (with this task in it), say nothing about how many and keep the button off.
  const counted = () =>
    boardLoaded() && boardTasks().some((one) => one.id === task().id);
  const cancelTreeBody = () => {
    if (!counted()) return t("tasks.cancelTree.counting");
    const under = cancelledWith(task().id, boardTasks());
    const body =
      under === 1
        ? t("tasks.cancelTree.bodyOne")
        : t("tasks.cancelTree.body", { count: under });
    const blocked = blockedByCancel(task());
    return blocked > 0 ? `${body} ${cancelImpact(blocked)}` : body;
  };
  const setStatus = (status: BoardTaskStatus): void => {
    close();
    if (status === task().status) return;
    call("tasks", "update", { taskId: task().id, status }).catch(showError);
  };
  const remove = (): void => {
    close();
    call("tasks", "delete", { taskId: task().id }).then(
      () => nav.pop(),
      showError,
    );
  };
  const edit = () => {
    close();
    openEditTask(task());
  };
  // Archiving: put away from the board's lists, back on anything new. A finished task goes at once;
  // one that is not, or that has a run going (which archiving stops), is asked about first.
  const archived = () => task().archivedAt != null;
  const running = () => task().runs.some((run) => isActive(run.status));
  const archive = (): void => {
    close();
    call("tasks", "archive", {
      taskId: task().id,
      ...(running() ? { stopRuns: true } : {}),
    }).then(
      () => toast(t("tasks.archive.done", { number: task().number })),
      showError,
    );
  };
  const restore = (): void => {
    close();
    call("tasks", "unarchive", { taskId: task().id }).then(
      () => toast(t("tasks.archive.restored", { number: task().number })),
      showError,
    );
  };
  const archiveOrAsk = (): void => {
    if (archived()) restore();
    else if (
      (task().status === "done" || task().status === "cancelled") &&
      !running()
    )
      archive();
    else sheet.set("archive");
  };
  return (
    <View
      class="flex-1"
      style={{ paddingBottom: "env(keyboard-inset-height)" }}
    >
      <Header
        crumb={`#${task().number}`}
        border={false}
        right={
          <View class="flex-row items-center gap-2" style={{ marginRight: -8 }}>
            <If
              when={task().subtasks == null}
              else={
                // A parent's status is its subtasks': a label, and "Auto" saying from how many.
                <View
                  role="button"
                  testID="task-status-auto"
                  accessibilityLabel={`${statusLabel(task().status)} · ${t("tasks.status.auto")}`}
                  accessibilityHint={autoHint()}
                  onPress={() => toast(autoHint())}
                  class="h-8 flex-row items-center gap-[6px] active:opacity-60"
                >
                  <StatusPill
                    status={task().status}
                    label={statusLabel(task().status)}
                  />
                  <Text class="text-sm leading-4 text-muted-foreground">
                    {t("tasks.status.auto")}
                  </Text>
                </View>
              }
            >
              <View
                role="button"
                testID="task-status"
                accessibilityLabel={`${t("tasks.fields.status")}: ${statusLabel(task().status)}`}
                onPress={() => sheet.set("status")}
                class={`h-8 flex-row items-center gap-[6px] border px-2 active:opacity-60 ${statusClasses(task().status).frame}`}
              >
                <TaskStatusIcon status={task().status} size={14} />
                <Text
                  class={`text-md leading-4 ${statusClasses(task().status).text}`}
                >
                  {statusLabel(task().status)}
                </Text>
                <Icon
                  name="caretDown"
                  size={12}
                  color={statusTone(task().status)}
                />
              </View>
            </If>
            <View
              role="button"
              testID="task-properties"
              accessibilityLabel={t("tasks.properties")}
              onPress={() => sheet.set("properties")}
              class="h-11 w-10 shrink-0 items-center justify-center active:opacity-60"
            >
              <Icon name="info" size={20} />
            </View>
            <View
              role="button"
              testID="task-more"
              accessibilityLabel={t("tasks.moreActions")}
              onPress={() => sheet.set("more")}
              class="h-11 w-10 shrink-0 items-center justify-center active:opacity-60"
            >
              <Icon name="dotsThree" size={20} />
            </View>
          </View>
        }
      />
      <View role="button" class="shrink-0 px-4 pb-[14px] pt-1" onPress={edit}>
        <Text class="text-title leading-[30px] tracking-[-0.01em] text-foreground">
          {task().title}
        </Text>
      </View>
      <If when={archived()}>
        <View
          testID="task-archived"
          class="mx-4 mb-3 flex-row items-center gap-3 border border-border px-3 py-2"
        >
          <View class="min-w-0 flex-1 gap-[2px]">
            <Text class="text-sm leading-[18px] text-foreground">
              {task().archivedBy === "auto"
                ? t("tasks.archive.bannerAuto", {
                    date: archiveDate(task().archivedAt ?? 0),
                  })
                : t("tasks.archive.banner", {
                    date: archiveDate(task().archivedAt ?? 0),
                  })}
            </Text>
            <Text class="text-sm leading-[18px] text-muted-foreground">
              {t("tasks.archive.hint")}
            </Text>
          </View>
          <View
            role="button"
            testID="task-restore"
            onPress={restore}
            class="h-9 shrink-0 justify-center border border-border px-3 active:opacity-60"
          >
            <Text class="text-sm text-foreground">
              {t("tasks.archive.restore")}
            </Text>
          </View>
        </View>
      </If>
      <Question task={task} onReply={() => focusBox()} />
      <View
        class={`min-h-0 grow basis-0 ${openQuestion(task()) === undefined ? "border-t border-border" : ""}`}
      >
        <Scroll
          ref={(ref: ScrollRef) => {
            scroll = ref;
          }}
          style={{ flex: 1 }}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        >
          <Thread task={task} onEdit={edit}>
            <OutgoingComments comments={comments} />
          </Thread>
        </Scroll>
      </View>
      <LiveRuns task={task} />
      <If
        when={
          task().subtasks != null &&
          !task().runs.some(
            (run) => run.agentId === null && isActive(run.status),
          )
        }
      >
        <View class="px-4 pb-1">
          <Text class="text-sm leading-[18px] text-muted-foreground">
            {t("tasks.graph.parentCommentHint")}
          </Text>
        </View>
      </If>
      <Composer
        task={task}
        comments={comments}
        focus={(focus) => {
          focusBox = focus;
        }}
      />
      <StatusSheet
        open={sheet() === "status"}
        value={task().status}
        dependents={blockedByCancel(task())}
        onChange={setStatus}
        onClose={close}
      />
      <PropertiesSheet
        open={sheet() === "properties"}
        task={task}
        onClose={close}
      />
      <Sheet open={sheet() === "more"} onClose={close}>
        <SheetOption
          label={t("tasks.more.edit")}
          testID="more-edit"
          onPress={edit}
        />
        <SheetOption
          label={t("tasks.log.title")}
          testID="more-runs"
          onPress={() => {
            close();
            openRuns(task());
          }}
        />
        <SheetOption
          label={t("tasks.more.link")}
          testID="more-link"
          onPress={() => sheet.set("link")}
        />
        <If when={task().subtasks != null && task().status !== "cancelled"}>
          <SheetOption
            label={t("tasks.more.cancelTree")}
            testID="more-cancel-tree"
            danger
            onPress={() => sheet.set("cancelTree")}
          />
        </If>
        <SheetOption
          label={
            archived() ? t("tasks.archive.restore") : t("tasks.archive.archive")
          }
          testID="more-archive"
          onPress={archiveOrAsk}
        />
        <SheetOption
          label={t("common.delete")}
          testID="more-delete"
          danger
          onPress={() => sheet.set("delete")}
        />
      </Sheet>
      <LinkSheet open={sheet() === "link"} task={task} onClose={close} />
      <ConfirmSheet
        open={sheet() === "cancelTree"}
        title={t("tasks.cancelTree.title", { number: task().number })}
        body={cancelTreeBody()}
        confirm={t("tasks.cancelTree.confirm")}
        disabled={!counted()}
        danger
        onConfirm={cancelTree}
        onClose={close}
      />
      <ConfirmSheet
        open={sheet() === "archive"}
        title={
          running()
            ? t("tasks.archive.runningTitle", { number: task().number })
            : t("tasks.archive.openTitle", { number: task().number })
        }
        body={t("tasks.archive.openBody", {
          status: statusLabel(task().status),
        })}
        confirm={
          running()
            ? t("tasks.archive.runningConfirm")
            : t("tasks.archive.archive")
        }
        danger={running()}
        onConfirm={archive}
        onClose={close}
      />
      <ConfirmSheet
        open={sheet() === "delete"}
        title={t("tasks.delete.title", { number: task().number })}
        body={t("tasks.delete.body")}
        confirm={t("common.delete")}
        danger
        onConfirm={remove}
        onClose={close}
      />
    </View>
  );
}

/** A task, or what stands where it would be: gone, on its way, or out of reach. */
export function TaskScreen(props: { id: string }) {
  const target = useTarget(`tasks.${props.id}`);
  const task = computed((): TaskDetail | undefined => {
    const detail = target.section<TaskDetailSections["task"]>("task");
    const activity = target.section<TaskDetailSections["activity"]>("activity");
    return target.missing() || detail === undefined || activity === undefined
      ? undefined
      : { ...detail, activity };
  });
  return (
    <Page bottom={false}>
      <If
        when={task()}
        else={
          <>
            <Header crumb={t("tasks.title")} border={false} />
            <If when={target.missing()}>
              <View class="border-b border-border">
                <Empty
                  title={t("tasks.gone.title")}
                  body={t("tasks.gone.body")}
                />
              </View>
            </If>
            <If when={!target.missing()}>
              <If
                when={wire().status() === "open"}
                else={
                  <Failed title={t("tasks.failed.title")} onRetry={retry} />
                }
              >
                <Loading />
              </If>
            </If>
          </>
        }
      >
        {(current) => <TaskView task={current} />}
      </If>
    </Page>
  );
}
