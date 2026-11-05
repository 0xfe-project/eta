import type { TaskDetailSections, TaskRunView } from "@eta/client-contracts";
import type { TaskDetail } from "./format";
import { Text, View } from "nsh";
import { t } from "../../i18n";
import { moment } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import { Body, Header, Page } from "../../ui/Page";
import { Empty, Loading } from "../../ui/States";
import { nav, open } from "../../nav/stack";
import { useTarget } from "../../wire/target";
import { ProcessView } from "../chat/process";
import { actorName, runActor, runLabel, shortPath } from "./format";

const useTask = (id: string) => {
  const target = useTarget(`tasks.${id}`);
  return () => target.section<TaskDetailSections["task"]>("task");
};

/** 06h: a run's own record, its session drawn as the chat draws one. */
export function RunLogScreen(props: { taskId: string; runId: string }) {
  const task = useTask(props.taskId);
  const run = () => task()?.runs.find((candidate) => candidate.id === props.runId);
  const heading = () => {
    const current = task();
    const found = run();
    return current === undefined || found === undefined
      ? t("tasks.log.title")
      : t("tasks.log.heading", {
          number: current.number,
          name: actorName(runActor(current, found)),
        });
  };
  const place = () => {
    const found = run();
    return found?.workspace === null || found?.workspace === undefined
      ? undefined
      : t("tasks.log.workspace", { path: shortPath(found.workspace, found.machineId) });
  };
  return (
    <Page>
      <View class="h-14 shrink-0 flex-row items-center gap-2 border-b border-border pl-2 pr-4">
        <View
          role="button"
          accessibilityLabel={t("common.back")}
          testID="back"
          onPress={() => nav.pop()}
          class="h-11 w-10 shrink-0 items-center justify-center active:opacity-60"
        >
          <Icon name="caretLeft" size={20} />
        </View>
        <View class="min-w-0 grow basis-0">
          <Text class="truncate text-lead leading-[20px] text-foreground">{heading()}</Text>
          <If when={place() !== undefined}>
            <Text class="truncate text-xs leading-4 text-muted-foreground">{place()}</Text>
          </If>
        </View>
      </View>
      <If
        when={run()?.sessionId}
        else={
          <If when={run() !== undefined} else={<Loading />}>
            <Empty title={t("tasks.log.empty")} />
          </If>
        }
      >
        {(session) => (
          <View class="flex-1">
            <ProcessView sessionId={session()} />
          </View>
        )}
      </If>
    </Page>
  );
}

export function openRunLog(taskId: string, runId: string): void {
  open(`task-run:${taskId}:${runId}`, () => <RunLogScreen taskId={taskId} runId={runId} />);
}

function RunRow(props: { task: () => NonNullable<ReturnType<ReturnType<typeof useTask>>>; run: TaskRunView }) {
  const run = () => props.run;
  const opens = () => run().sessionId !== null;
  return (
    <View
      role="button"
      accessibilityLabel={actorName(runActor(props.task(), run()))}
      disabled={!opens()}
      onPress={() => openRunLog(props.task().id, run().id)}
      class="h-14 shrink-0 flex-row items-center gap-[10px] border-b border-border px-4 active:bg-muted"
    >
      <View class="min-w-0 grow basis-0">
        <Text class="truncate text-base leading-[20px] text-foreground">
          {`${actorName(runActor(props.task(), run()))} · ${runLabel(run().status)}`}
        </Text>
        <Text class="truncate text-sm leading-4 text-muted-foreground">
          {[
            moment(run().startedAt ?? run().createdAt),
            run().continuesRunId === null ? undefined : t("tasks.log.continues"),
            run().status === "failed" ? (run().error ?? undefined) : undefined,
          ]
            .filter((part) => part !== undefined)
            .join(" · ")}
        </Text>
      </View>
      <If when={opens()}>
        <Icon name="caretRight" size={14} color="faint" />
      </If>
    </View>
  );
}

/** Every run of a task, newest first; each opens its log. */
export function RunsScreen(props: { id: string }) {
  const task = useTask(props.id);
  return (
    <Page>
      <If when={task()} else={<Header crumb={t("tasks.title")} border={false} />}>
        {(current) => (
          <>
            <Header title={t("tasks.log.title")} subtitle={`#${current().number} ${current().title}`} />
            <If
              when={current().runs.length > 0}
              else={<Empty title={t("tasks.log.empty")} />}
            >
              <Body>
                <Each of={[...current().runs].reverse()} key={(run) => run.id}>
                  {(run) => <RunRow task={current} run={run()} />}
                </Each>
              </Body>
            </If>
          </>
        )}
      </If>
    </Page>
  );
}

/** 执行记录 from a task: straight to the log when there is only one to read. */
export function openRuns(task: TaskDetail): void {
  const readable = task.runs.filter((run) => run.sessionId !== null);
  const only = readable[0];
  if (readable.length === 1 && only !== undefined && task.runs.length === 1) {
    openRunLog(task.id, only.id);
    return;
  }
  open(`task-runs:${task.id}`, () => <RunsScreen id={task.id} />);
}

