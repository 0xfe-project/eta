import type {
  BoardTaskDetail,
  MachineView,
  TaskRunView,
} from "@eta/client-contracts";
import type { Layout } from "../../components";
import { cleanup, effect, signal, View } from "nsh";
import { Button, colors, grow, Label, row } from "../../components";
import { space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { problemText } from "../../services/problem-text";
import { MemberRun } from "../chat/run/member-run";
import { RunPanel } from "../chat/run/run-panel";

/** The bar under a running run's log, with its stop button. */
const stopBarHeight = { phone: 56, regular: 44 } as const;

export function isActiveRunStatus(status: TaskRunView["status"]): boolean {
  return status === "queued" || status === "starting" || status === "running";
}

export function activeTaskRun(run: TaskRunView): boolean {
  return isActiveRunStatus(run.status);
}

/** The executor's own runs, oldest first: a mentioned agent answering is not the task running. */
function executorRuns(item: BoardTaskDetail): TaskRunView[] {
  return item.runs.filter((run) => run.agentId === null);
}

/** The executor's newest run: what the task's own run state and timing say. */
export function latestExecutorRun(
  item: BoardTaskDetail,
): TaskRunView | undefined {
  return executorRuns(item).at(-1);
}

/** Which of its agent's runs on the task a run is, from 1: the executor's and each mentioned agent's count apart. */
function runNumber(runs: TaskRunView[], run: TaskRunView): number {
  const own = runs.filter((other) => other.agentId === run.agentId);
  return Math.max(1, own.findIndex((other) => other.id === run.id) + 1);
}

/** A run's name, with whose it is: "Run 2 · Ada", or "Answer 1 · Bob (mentioned)". */
export function runTitle(
  runs: TaskRunView[],
  run: TaskRunView,
  name: string,
): string {
  return uiText(run.agentId === null ? "taskRunExecutor" : "taskRunMentioned", {
    number: runNumber(runs, run),
    name,
  });
}

/** What a run that has not ended is doing; "delivered" is the executor's run once the task is in review. */
export type RunDoing =
  | "working"
  | "answering"
  | "starting"
  | "queued"
  | "delivered";

/**
 * What is going on a task right now, one line per run, as on the web: the executor working, an
 * agent mentioned on the task answering, a run waiting its turn. While the task is in review, its
 * executor's delivered run leads. A mentioned agent's answer never reads as the task running.
 */
export function liveRuns(
  item: BoardTaskDetail,
): { run: TaskRunView; doing: RunDoing }[] {
  const lines = item.runs
    .filter((run) => activeTaskRun(run))
    .map((run) => ({
      run,
      doing: (run.status === "queued"
        ? "queued"
        : run.status === "starting"
          ? "starting"
          : run.agentId === null
            ? "working"
            : "answering") as RunDoing,
    }));
  const own = latestExecutorRun(item);
  if (own && !activeTaskRun(own) && item.status === "in_review")
    lines.unshift({ run: own, doing: "delivered" });
  return lines;
}

/** "Ada is working", "Bob is answering (mentioned)", "Ada is queued". */
export function runDoingText(doing: RunDoing, name: string): string {
  return uiText(
    doing === "answering"
      ? "taskIsAnswering"
      : doing === "queued"
        ? "taskIsQueued"
        : doing === "starting"
          ? "taskIsStarting"
          : doing === "delivered"
            ? "taskDeliveredTurn"
            : "taskIsWorking",
    { name },
  );
}

/** The time now, ticking each second while `on` holds: what a running run's clock reads. */
export function runClock(on: () => boolean) {
  const now = signal(Date.now());
  effect(() => {
    if (!on()) return;
    now.set(Date.now());
    const timer = setInterval(() => now.set(Date.now()), 1000);
    cleanup(() => clearInterval(timer));
  });
  return now;
}

/** How long a run has gone, or went: "4m 12s". `now` is a ticking clock's reading, for one still going. */
export function runElapsed(run: TaskRunView, now = Date.now()): string {
  const start = run.startedAt ?? run.createdAt;
  const seconds = Math.max(
    0,
    Math.floor(((run.finishedAt ?? now) - start) / 1000),
  );
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function runState(run: TaskRunView): string {
  switch (run.status) {
    case "completed":
      return uiText("taskRunDone");
    case "failed":
    case "interrupted":
      return uiText("taskRunStopped");
    case "queued":
      return uiText("taskRunQueued");
    default:
      return uiText("taskRunRunning");
  }
}

export function TaskRunLog(props: {
  run: TaskRunView;
  /** The task's runs, oldest first: which of its agent's runs this one is. */
  runs: TaskRunView[];
  /** Whose run it is: the executor's name, or the mentioned agent's. */
  executor: string;
  agentId: string;
  layout: Layout;
  nextRunAt?: number;
  stopping: boolean;
  onStop: () => void;
  onClose: () => void;
}) {
  const c = colors();
  const phone = () => props.layout === "phone";
  const host = useHost();
  follow(() => "machines");
  const machine = () =>
    host
      .list<MachineView>("machines")
      .find((entry) => entry.id === props.run.machineId)?.name;
  /** "Run 1 · took 4m 12s · Running · Machine This machine". */
  const meta = () =>
    [
      uiText(props.run.agentId === null ? "taskRunTook" : "taskAnswerTook", {
        number: runNumber(props.runs, props.run),
        elapsed: runElapsed(props.run),
      }),
      runState(props.run),
      machine() && uiText("taskRunMachine", { name: machine()! }),
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <RunPanel
      title={
        phone()
          ? runTitle(props.runs, props.run, props.executor)
          : `${runTitle(props.runs, props.run, props.executor)} · ${runElapsed(props.run)}`
      }
      phone={phone()}
      hideHeader={!phone() && !!props.run.sessionId}
      onClose={props.onClose}
    >
      <If
        when={props.run.sessionId}
        else={
          <View style={{ ...grow, padding: space[16], gap: space[8] }}>
            <Label variant="small" tone={props.run.error ? "red" : "muted"}>
              {(props.run.error && problemText(props.run.error)) ??
                (props.run.status === "queued"
                  ? uiText("awaitingTaskSession")
                  : uiText("noLogEntriesYet"))}
            </Label>
          </View>
        }
      >
        {(session) => (
          <MemberRun
            session={session()}
            agentId={props.agentId}
            executorName={props.executor}
            taskRun={props.run}
            meta={phone() ? undefined : meta()}
            nextRunAt={props.nextRunAt}
            phone={phone()}
            onClose={props.onClose}
          />
        )}
      </If>
      <If when={activeTaskRun(props.run)}>
        <View
          style={{
            ...row,
            paddingHorizontal: space[16],
            minHeight: phone() ? stopBarHeight.phone : stopBarHeight.regular,
            gap: space[8],
            borderTopWidth: 1,
            borderColor: c().border,
          }}
        >
          <Label variant="small" tone="muted" style={{ flex: 1 }}>
            {uiText("readOnlyReplyOnTheTask", { executor: props.executor })}
          </Label>
          <Button
            label={uiText("stop")}
            disabled={props.stopping}
            onPress={props.onStop}
          />
        </View>
      </If>
    </RunPanel>
  );
}
