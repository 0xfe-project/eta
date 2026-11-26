import type {
  BoardTaskDetail,
  BoardTaskView,
  MachineView,
} from "@eta/client-contracts";
import { signal, View } from "nsh";
import {
  Button,
  colors,
  Field,
  grow,
  Label,
  Modal,
  row,
  SmoothScroll,
} from "../../../components";
import { EmptyState } from "../../../components/empty-state";
import { StatusDot } from "../../../components/status-dot";
import { control, icon, space, weight } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { follow, relativeTime, useHost } from "../../../services/host";
import { problemText } from "../../../services/problem-text";
import { TaskGlyph } from "../../tasks/status";
import { EntityRow, leadingBoxWidth, SectionHeader } from "../section";
import { SettingRow } from "../setting-row";
import { MachineRunsLimit, RemoveMachine } from "./machine-dialogs";
import { useMachineUpdate } from "./machine-update";
import { machineStatus } from "./machines";

/** A machine's detail dialog off phones. */
const detailHeight = 488;

export function MachineDetail(props: {
  item: MachineView;
  phone: boolean;
  onTask: (id: string) => void;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const fingerprint = signal("");
  const editing = signal(false);
  const removing = signal(false);
  const busy = signal(false);
  const machineUpdate = useMachineUpdate(() => props.item);
  const pending = () => props.item.status === "pending";
  const candidates = () =>
    host.tasks().filter((item) => item.status === "in_progress");
  const statusTone = () =>
    props.item.status === "online" ? "green" : pending() ? "warning" : "muted";
  const statusLabel = () =>
    props.item.status === "online"
      ? uiText("machineOnline")
      : machineStatus(props.item);
  const active = () =>
    candidates().filter((item) =>
      host
        .section<BoardTaskDetail>(`tasks.${item.id}`, "task")
        ?.runs.some(
          (run) =>
            run.machineId === props.item.id &&
            (run.status === "starting" || run.status === "running"),
        ),
    );
  const runsAtOnce = () => `${active().length} / ${props.item.maxActiveRuns}`;
  const editLimit = () => editing.set(true);
  /** "#12 · Bo · 8m": the task, who runs it here, and for how long. */
  const runMeta = (task: BoardTaskView) => {
    const run = host
      .section<BoardTaskDetail>(`tasks.${task.id}`, "task")
      ?.runs.filter(
        (entry) =>
          entry.machineId === props.item.id &&
          (entry.status === "starting" || entry.status === "running"),
      )
      .at(-1);
    const agentId =
      run?.agentId ?? task.assigneeAgentId ?? task.createdBy.agentId;
    return [
      `#${task.number}`,
      host.people().find((agent) => agent.id === agentId)?.name,
      run?.startedAt ? relativeTime(run.startedAt) : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
  };
  const rowStyle = () => ({
    ...row,
    minHeight: control.touch,
    paddingHorizontal: space[16],
    paddingVertical: props.phone ? space[8] : undefined,
    gap: props.phone ? space[16] : space[12],
    borderBottomWidth: 1,
    borderColor: c().border,
  });
  const upgrade = () =>
    (props.item.kind === "daemon" &&
      props.item.install === "service" &&
      props.item.status === "online" &&
      (props.item.build === "outdated" || !!props.item.updateError)) ||
    machineUpdate.state() === "updating";
  async function act(action: () => Promise<unknown>, onSuccess?: () => void) {
    if (busy()) return;
    busy.set(true);
    const result = await host.action(action);
    busy.set(false);
    if (result !== undefined) onSuccess?.();
  }
  return (
    <Modal
      title={props.item.name}
      subtitle={statusLabel()}
      subtitleTone={statusTone()}
      phone={props.phone}
      phonePage={props.phone}
      height={props.phone ? "100%" : detailHeight}
      onClose={props.onClose}
    >
      <SmoothScroll style={grow} scrollbar={false}>
        <If
          when={pending()}
          else={
            <>
              <Each
                of={[
                  [
                    uiText("machineSystem"),
                    machineSystem(props.item.os) ?? props.item.platform,
                  ],
                  [uiText("machineFolder"), props.item.home],
                  [
                    uiText("machineBuild"),
                    [
                      props.item.version,
                      props.item.build === "outdated"
                        ? uiText("machineNeedsUpdate")
                        : props.item.build === "updating"
                          ? uiText("updating")
                          : null,
                    ]
                      .filter(Boolean)
                      .join(" · "),
                  ],
                ]}
              >
                {(field) => (
                  <If when={field()[1]}>
                    <View style={rowStyle()}>
                      <Label style={{ flexShrink: 0 }}>{field()[0]}</Label>
                      <View
                        style={{
                          ...row,
                          flex: 1,
                          minWidth: 0,
                          gap: space[4],
                          justifyContent: "flex-end",
                        }}
                      >
                        <If
                          when={
                            props.phone &&
                            field()[0] === uiText("machineBuild") &&
                            props.item.build === "outdated"
                          }
                        >
                          <StatusDot color={c().warning} />
                        </If>
                        <Label
                          variant="small"
                          lines={2}
                          tone={
                            props.phone &&
                            field()[0] === uiText("machineBuild") &&
                            props.item.build === "outdated"
                              ? "mutedInk"
                              : "ink"
                          }
                          style={{ flexShrink: 1, textAlign: "right" }}
                        >
                          {field()[1]}
                        </Label>
                      </View>
                    </View>
                  </If>
                )}
              </Each>
              <If
                when={props.phone}
                else={
                  <View style={rowStyle()}>
                    <Label style={{ flex: 1 }}>
                      {uiText("taskRunsAtOnce")}
                    </Label>
                    <Button
                      label={runsAtOnce()}
                      tone="ghost"
                      end="right"
                      onPress={editLimit}
                    />
                  </View>
                }
              >
                <View
                  role="button"
                  accessibilityLabel={uiText("taskRunsAtOnce")}
                  onPress={editLimit}
                  style={{ ...rowStyle(), cursor: "pointer" }}
                >
                  <Label style={{ flex: 1 }}>{uiText("taskRunsAtOnce")}</Label>
                  <Label variant="small">{runsAtOnce()}</Label>
                </View>
              </If>
              <If
                when={props.phone}
                else={
                  <View style={rowStyle()}>
                    <Label weight={weight.strong}>
                      {uiText("runningOnThisMachine")}
                    </Label>
                    <Label variant="small" tone="muted">
                      {active().length}
                    </Label>
                  </View>
                }
              >
                <SectionHeader
                  title={uiText("runningOnThisMachine")}
                  count={active().length}
                  phone
                />
              </If>
              <If when={!active().length}>
                <EmptyState
                  size="row"
                  status="empty"
                  loading={null}
                  error={null}
                  empty={{ title: uiText("nothingRunningOnThisMachine") }}
                  style={{ paddingHorizontal: space[16] }}
                />
              </If>
              <Each of={active()} key={(item) => item.id}>
                {(item) => (
                  <If
                    when={props.phone}
                    else={
                      <SettingRow
                        icon="tasks"
                        title={item().title}
                        detail={uiText("workingWithCount", {
                          number: item().number,
                        })}
                        onPress={() => props.onTask(item().id)}
                      />
                    }
                  >
                    <EntityRow
                      title={item().title}
                      leading={
                        <TaskGlyph status={item().status} size={icon.md} />
                      }
                      leadingSize={leadingBoxWidth}
                      stacked
                      caret
                      status={{
                        label: uiText("machineRunWorking"),
                        color: c().blue,
                      }}
                      meta={runMeta(item())}
                      onPress={() => props.onTask(item().id)}
                    />
                  </If>
                )}
              </Each>
            </>
          }
        >
          <View
            style={{
              padding: space[16],
              gap: space[8],
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label>
              {uiText("wantsToConnectPasteTheFingerprint", {
                name: props.item.name,
              })}
            </Label>
            <Field
              label={uiText("machineFingerprint")}
              placeholder={uiText("pasteTheFingerprintFromTheTerminal")}
              value={fingerprint()}
              onChange={fingerprint.set}
            />
            <Label variant="small" tone="muted">
              {uiText("agentsRunOnThatMachineWith")}
            </Label>
          </View>
        </If>
        <Each of={pending() ? [] : candidates()} key={(item) => item.id}>
          {(item) => <MachineTaskSubscription id={item().id} />}
        </Each>
        <If when={props.item.kind !== "primary"}>
          <View style={rowStyle()}>
            <Label style={{ flex: 1 }}>{uiText("removeMachine")}</Label>
            <Button
              label={uiText("remove2")}
              size={props.phone ? control.md : undefined}
              style={props.phone ? { paddingHorizontal: space[12] } : undefined}
              onPress={() => removing.set(true)}
            />
          </View>
        </If>
        <If when={props.item.updateError}>
          <Label tone="red" variant="small" style={{ padding: space[16] }}>
            {problemText(props.item.updateError ?? "")}
          </Label>
        </If>
      </SmoothScroll>
      <If when={pending() || upgrade()}>
        <View
          style={{
            paddingHorizontal: space[16],
            paddingVertical: space[8],
            borderTopWidth: 1,
            borderColor: c().border,
          }}
        >
          <If
            when={pending()}
            else={
              <Button
                label={
                  machineUpdate.state() === "updating"
                    ? machineUpdate.label()!
                    : props.phone && host.upgradeCheck()?.version
                      ? uiText("updateMachineTo", {
                          version: host.upgradeCheck()!.version,
                        })
                      : uiText("updateMachine")
                }
                tone="primary"
                size={props.phone ? control.lg : undefined}
                style={props.phone ? { alignSelf: "stretch" } : undefined}
                disabled={busy() || machineUpdate.state() === "updating"}
                onPress={() => void machineUpdate.start()}
              />
            }
          >
            <Button
              label={uiText("approve")}
              tone="primary"
              size={props.phone ? control.lg : undefined}
              style={props.phone ? { alignSelf: "stretch" } : undefined}
              disabled={busy() || !fingerprint().trim()}
              onPress={() =>
                void act(
                  () =>
                    host.call("machines", "approve", {
                      machineId: props.item.id,
                      fingerprint: fingerprint().trim(),
                    }),
                  () => fingerprint.set(""),
                )
              }
            />
          </If>
        </View>
      </If>
      <If when={editing()}>
        <MachineRunsLimit
          item={props.item}
          phone={props.phone}
          onClose={() => editing.set(false)}
        />
      </If>
      <If when={removing()}>
        <RemoveMachine
          item={props.item}
          phone={props.phone}
          onClose={() => removing.set(false)}
          onRemoved={props.onClose}
        />
      </If>
    </Modal>
  );
}

export function machineSystem(os: string | null) {
  if (os === "darwin") return "macOS";
  if (os === "linux") return "Linux";
  if (os === "win32" || os === "windows") return "Windows";
  return os;
}

function MachineTaskSubscription(props: { id: string }) {
  follow(() => `tasks.${props.id}`);
  return null;
}
