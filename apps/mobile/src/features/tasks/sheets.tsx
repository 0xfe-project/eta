import type { BoardTaskStatus } from "@eta/client-contracts";
import type { JSX } from "nsh";
import type { TaskDetail } from "./format";
import { Scroll, signal, Text, View } from "nsh";
import { conversations, machineById, projectById } from "../../app/lists";
import { t } from "../../i18n";
import { Icon } from "../../ui/Icon";
import { Sheet } from "../../ui/Sheet";
import { toast } from "../../ui/toast";
import { call } from "../../wire/target";
import {
  actorName,
  executor,
  failure,
  isActive,
  runLabel,
  shortPath,
  STATUS_ICONS,
  statusLabel,
  STATUSES,
  updated,
} from "./format";

const showError = (error: unknown) =>
  toast(t("common.failed", { message: failure(error) }));

function SheetTitle(props: { title: string }) {
  return (
    <View class="h-[52px] shrink-0 flex-row items-center px-4">
      <Text class="text-lead leading-[18px] text-foreground">
        {props.title}
      </Text>
    </View>
  );
}

/** A sheet's row, as 06e draws them. */
export function SheetOption(props: {
  label: string;
  danger?: boolean;
  testID?: string;
  onPress: () => void;
}) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      onPress={props.onPress}
      class="h-[52px] shrink-0 flex-row items-center border-t border-border px-4 active:bg-muted"
    >
      <Text
        class={`text-lead leading-[18px] ${props.danger ? "text-state-error" : "text-foreground"}`}
      >
        {props.label}
      </Text>
    </View>
  );
}

/** 06d. */
export function StatusSheet(props: {
  open: boolean;
  value: BoardTaskStatus;
  onChange: (status: BoardTaskStatus) => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={props.open} onClose={props.onClose}>
      <SheetTitle title={t("tasks.fields.status")} />
      <Each of={STATUSES}>
        {(status) => (
          <View
            role="button"
            testID={`status-${status()}`}
            accessibilityLabel={statusLabel(status())}
            onPress={() => props.onChange(status())}
            class={`h-[52px] shrink-0 flex-row items-center gap-[10px] border-t border-border px-4 active:bg-muted ${props.value === status() ? "bg-muted" : ""}`}
          >
            <Icon
              name={STATUS_ICONS[status()]}
              size={18}
              color="muted-foreground"
            />
            <Text class="grow basis-0 text-lead leading-[18px] text-foreground">
              {statusLabel(status())}
            </Text>
            <If when={props.value === status()}>
              <Icon name="check" size={16} />
            </If>
          </View>
        )}
      </Each>
    </Sheet>
  );
}

function Row(props: { label: string; children: JSX.Element }) {
  return (
    <View class="flex-row gap-3 border-t border-border px-4 py-3">
      <Text class="w-12 shrink-0 text-sm leading-[20px] text-muted-foreground">
        {props.label}
      </Text>
      {props.children}
    </View>
  );
}

/** The run row: how the latest went, and starting over once none is going. */
function RunsRow(props: { task: () => TaskDetail; onDone: () => void }) {
  // The executor's runs: a mentioned agent answering is not the task running.
  const own = () => props.task().runs.filter((run) => run.agentId === null);
  const latest = () => own().at(-1);
  const going = () => own().some((run) => isActive(run.status));
  const busy = signal(false);
  const rerun = (): void => {
    if (busy()) return;
    busy.set(true);
    call("tasks", "rerun", { taskId: props.task().id })
      .then(props.onDone, showError)
      .finally(() => busy.set(false));
  };
  const words = () => {
    const run = latest();
    if (run === undefined) return t("tasks.run.never");
    const label = runLabel(run.status);
    return run.status === "failed" && run.error
      ? `${label}：${run.error}`
      : label;
  };
  return (
    <Row label={t("tasks.fields.runs")}>
      <View class="min-w-0 grow basis-0 gap-[6px]">
        <View class="flex-row items-center gap-2">
          <View class="min-w-0 grow basis-0 flex-row items-center gap-1">
            <If when={going()}>
              <Icon
                name={latest()?.status === "queued" ? "clock" : "spinner"}
                size={14}
              />
            </If>
            <Text
              class={`min-w-0 shrink text-base leading-[20px] ${latest()?.status === "failed" ? "text-state-error" : "text-foreground"}`}
            >
              {words()}
            </Text>
          </View>
          <If when={!going()}>
            <View
              role="button"
              testID="task-rerun"
              onPress={rerun}
              class="h-8 flex-row items-center gap-1 border border-border-strong px-2 active:bg-muted"
            >
              <Icon name="arrowClockwise" size={14} />
              <Text class="text-md leading-4 text-foreground">
                {latest() === undefined
                  ? t("tasks.run.start")
                  : t("tasks.run.rerun")}
              </Text>
            </View>
          </If>
        </View>
        <If when={latest() !== undefined && !going()}>
          <Text class="text-sm leading-[18px] text-muted-foreground">
            {t("tasks.run.fromScratchHint")}
          </Text>
        </If>
      </View>
    </Row>
  );
}

/** 06c, 06c2. */
export function PropertiesSheet(props: {
  open: boolean;
  task: () => TaskDetail;
  onClose: () => void;
}) {
  const task = props.task;
  // The latest run says where the work really is. On another machine than the project's it had no
  // worktree: the row names that machine and where the run started instead.
  const latest = () =>
    task()
      .runs.filter((run) => run.agentId === null)
      .at(-1);
  const away = () => {
    const run = latest();
    const project = projectById(task().projectId);
    if (
      run === undefined ||
      project === undefined ||
      run.machineId === project.machineId
    )
      return undefined;
    return machineById(run.machineId)?.name;
  };
  const machineId = () =>
    away() === undefined
      ? projectById(task().projectId)?.machineId
      : latest()?.machineId;
  const path = () =>
    away() === undefined ? task().workspace.path : latest()?.workspace;
  const mode = () =>
    task().workspace.mode === "worktree"
      ? t("tasks.workspace.worktree")
      : t("tasks.workspace.local");
  return (
    <Sheet open={props.open} onClose={props.onClose}>
      <SheetTitle title={t("tasks.properties")} />
      <If when={task().createdBy.kind === "agent"}>
        <Row label={t("tasks.fields.executor")}>
          <Text class="min-w-0 grow basis-0 text-base leading-[20px] text-foreground">
            {actorName(executor(task()))}
          </Text>
        </Row>
        <Row label={t("tasks.fields.workspace")}>
          <View class="min-w-0 grow basis-0">
            <Text class="text-base leading-[20px] text-foreground">
              {away() === undefined
                ? mode()
                : t("tasks.workspace.away", { machine: away() ?? "" })}
              <If
                when={away() === undefined && task().workspace.branch !== null}
              >
                <Text class="text-muted-foreground">
                  {" "}
                  · {task().workspace.branch}
                </Text>
              </If>
            </Text>
            <If when={path()}>
              {(where) => (
                <Text class="text-sm leading-[18px] text-muted-foreground">
                  {shortPath(where(), machineId())}
                </Text>
              )}
            </If>
          </View>
        </Row>
        <RunsRow task={task} onDone={props.onClose} />
      </If>
      <Row label={t("tasks.fields.updatedAt")}>
        <Text class="min-w-0 grow basis-0 text-base leading-[20px] text-foreground">
          {updated(task().updatedAt)}
        </Text>
      </Row>
    </Sheet>
  );
}

/** Where a task is discussed: the same choice as 05c, and none. */
export function LinkSheet(props: {
  open: boolean;
  task: () => TaskDetail;
  onClose: () => void;
}) {
  const groups = () =>
    conversations().filter(
      (group) => group.kind === "group" && !group.archived,
    );
  const link = (conversationId: string | null): void => {
    props.onClose();
    if (conversationId === props.task().conversationId) return;
    call("tasks", "link", { taskId: props.task().id, conversationId }).catch(
      showError,
    );
  };
  return (
    <Sheet open={props.open} onClose={props.onClose}>
      <SheetTitle title={t("tasks.link.title")} />
      <Scroll style={{ maxHeight: 480 }}>
        <Each of={groups()} key={(group) => group.id}>
          {(group) => (
            <View
              role="button"
              accessibilityLabel={group().name}
              onPress={() => link(group().id)}
              class="h-[52px] shrink-0 flex-row items-center gap-[10px] border-t border-border px-4 active:bg-muted"
            >
              <Text class="min-w-0 grow basis-0 truncate text-lead leading-[18px] text-foreground">
                {group().name}
              </Text>
              <If when={props.task().conversationId === group().id}>
                <Icon name="check" size={16} />
              </If>
            </View>
          )}
        </Each>
        <SheetOption label={t("tasks.link.none")} onPress={() => link(null)} />
      </Scroll>
    </Sheet>
  );
}
