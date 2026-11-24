import type { MachineView, TaskRunView } from "@eta/client-contracts";
import type { Layout } from "../../components";
import { View } from "nsh";
import { Button, colors, grow, Label, row } from "../../components";
import { space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { MemberRun } from "../chat/run/member-run";
import { RunPanel } from "../chat/run/run-panel";

export function isActiveRunStatus(status: TaskRunView["status"]): boolean {
  return status === "queued" || status === "starting" || status === "running";
}

export function activeTaskRun(run: TaskRunView): boolean {
  return isActiveRunStatus(run.status);
}

/** How long a run has gone, or went: "4m 12s". */
export function runElapsed(run: TaskRunView): string {
  const start = run.startedAt ?? run.createdAt;
  const seconds = Math.max(
    0,
    Math.floor(((run.finishedAt ?? Date.now()) - start) / 1000),
  );
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function runCaption(run: TaskRunView, index: number): string {
  return `Run ${index + 1} · ${runElapsed(run)}`;
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
  index: number;
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
      uiText("taskRunTook", {
        number: props.index + 1,
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
          ? uiText("taskRunExecutor", {
              number: props.index + 1,
              name: props.executor,
            })
          : `${runCaption(props.run, props.index)} · ${props.executor}`
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
              {props.run.error ??
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
            minHeight: phone() ? 56 : 42,
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
