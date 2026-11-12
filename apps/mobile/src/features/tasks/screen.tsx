import type {
  BoardTaskStatus,
  TaskDetailSections,
  TaskRunView,
} from "@eta/client-contracts";
import type { ScrollRef } from "nsh";
import type { TaskDetail } from "./format";
import { computed, effect, Scroll, signal, Text, View } from "nsh";
import { retry, wire } from "../../app/session";
import { t } from "../../i18n";
import { nav } from "../../nav/stack";
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/Markdown";
import { Header, Page } from "../../ui/Page";
import { ConfirmSheet, Sheet } from "../../ui/Sheet";
import { Empty, Failed, Loading } from "../../ui/States";
import { toast } from "../../ui/toast";
import { call, useTarget } from "../../wire/target";
import { Composer, OutgoingComments, useComments } from "./composer";
import { openEditTask } from "./edit";
import {
  actorName,
  failure,
  isActive,
  queueReason,
  runActor,
  STATUS_ICONS,
  statusColor,
  statusLabel,
} from "./format";
import { openRunLog, openRuns } from "./runs";
import { LinkSheet, PropertiesSheet, SheetOption, StatusSheet } from "./sheets";
import { openQuestion, Thread } from "./thread";

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
      ? queueReason(code, run().machineId)
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

type Open = "status" | "properties" | "more" | "link" | "delete";

function TaskView(props: { task: () => TaskDetail }) {
  const task = props.task;
  const sheet = signal<Open | undefined>(undefined);
  const comments = useComments(task);
  let focusBox = (): void => undefined;
  let scroll: ScrollRef | undefined;
  const close = () => sheet.set(undefined);

  // A thread opens on its latest word, next to the box to answer it.
  effect(() => {
    task().activity.length;
    comments.waiting().length;
    setTimeout(() => scroll?.scrollToEnd({ animated: false }), 0);
  });

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
            <View
              role="button"
              testID="task-status"
              accessibilityLabel={t("tasks.fields.status")}
              onPress={() => sheet.set("status")}
              class="h-8 flex-row items-center gap-[6px] border border-border-strong px-2 active:bg-muted"
            >
              <Icon
                name={STATUS_ICONS[task().status]}
                size={14}
                color={statusColor(task().status)}
              />
              <Text class="text-md leading-4 text-foreground">
                {statusLabel(task().status)}
              </Text>
              <Icon name="caretDown" size={12} color="muted-foreground" />
            </View>
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
        <SheetOption
          label={t("common.delete")}
          testID="more-delete"
          danger
          onPress={() => sheet.set("delete")}
        />
      </Sheet>
      <LinkSheet open={sheet() === "link"} task={task} onClose={close} />
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
