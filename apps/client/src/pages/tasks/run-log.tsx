import type { TaskRunView } from "@eta/client-contracts";
import type { Layout } from "../../components";
import { View, windowSize } from "nsh";
import { Button, colors, grow, Label, Modal, row } from "../../components";
import { uiText } from "../../i18n";
import { MemberRun } from "../chat/run/member-run";

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
  return (
    <Modal
      title={
        phone()
          ? uiText("taskRunExecutor", {
              number: props.index + 1,
              name: props.executor,
            })
          : `${runCaption(props.run, props.index)} · ${props.executor}`
      }
      width={
        props.layout === "desktop" ? 960 : Math.max(0, windowSize().width - 144)
      }
      height={
        phone()
          ? "100%"
          : Math.max(
              0,
              windowSize().height - (props.layout === "desktop" ? 100 : 48),
            )
      }
      phone={phone()}
      phonePage={phone()}
      hideHeader={!phone() && !!props.run.sessionId}
      modalFocus
      blurBackdrop={!phone()}
      overPhoneNavigation
      onClose={props.onClose}
    >
      <If
        when={props.run.sessionId}
        else={
          <View style={{ ...grow, padding: 16, gap: 8 }}>
            <Label size={12} tone={props.run.error ? "red" : "muted"}>
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
            paddingHorizontal: 16,
            minHeight: phone() ? 56 : 42,
            gap: 8,
            borderTopWidth: 1,
            borderColor: c().border,
          }}
        >
          <Label size={12} tone="muted" style={{ flex: 1 }}>
            {uiText("readOnlyReplyOnTheTask", { executor: props.executor })}
          </Label>
          <Button
            label={uiText("stop")}
            disabled={props.stopping}
            onPress={props.onStop}
          />
        </View>
      </If>
    </Modal>
  );
}
