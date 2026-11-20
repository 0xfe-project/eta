import type { BoardTaskDetail, MachineView } from "@eta/client-contracts";
import { Scroll, signal, View } from "nsh";
import {
  Button,
  colors,
  Field,
  grow,
  Label,
  Modal,
  row,
} from "../../../components";
import { uiText } from "../../../i18n";
import { follow, useHost } from "../../../services/host";
import { SettingRow } from "../setting-row";
import { machineStatus } from "./machines";

export function MachineDetail(props: {
  item: MachineView;
  phone: boolean;
  onTask: (id: string) => void;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const fingerprint = signal("");
  const limit = signal("");
  const editing = signal(false);
  const removing = signal(false);
  const busy = signal(false);
  const pending = () => props.item.status === "pending";
  const candidates = () =>
    host.tasks().filter((item) => item.status === "in_progress");
  const statusTone = () =>
    props.item.status === "online" ? "green" : pending() ? "amber" : "muted";
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
  const rowStyle = () => ({
    ...row,
    minHeight: 44,
    paddingHorizontal: 16,
    gap: 12,
    borderBottomWidth: 1,
    borderColor: c().border,
  });
  const upgrade = () =>
    props.item.kind === "daemon" &&
    props.item.install === "service" &&
    props.item.status === "online" &&
    (props.item.build === "outdated" || !!props.item.updateError);
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
      height={props.phone ? "100%" : 490}
      onClose={props.onClose}
    >
      <Scroll style={grow} scrollbar={false}>
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
                      <Label
                        size={12}
                        lines={2}
                        style={{ flex: 1, minWidth: 0, textAlign: "right" }}
                      >
                        {field()[1]}
                      </Label>
                    </View>
                  </If>
                )}
              </Each>
              <View style={rowStyle()}>
                <Label style={{ flex: 1 }}>{uiText("taskRunsAtOnce")}</Label>
                <Button
                  label={`${active().length} / ${props.item.maxActiveRuns}`}
                  tone="ghost"
                  end="right"
                  onPress={() => {
                    limit.set(String(props.item.maxActiveRuns));
                    editing.set(true);
                  }}
                />
              </View>
              <View style={rowStyle()}>
                <Label weight={600}>{uiText("runningOnThisMachine")}</Label>
                <Label size={12} tone="muted">
                  {active().length}
                </Label>
              </View>
              <Each of={active()} key={(item) => item.id}>
                {(item) => (
                  <SettingRow
                    icon="tasks"
                    title={item().title}
                    detail={uiText("workingWithCount", {
                      number: item().number,
                    })}
                    onPress={() => props.onTask(item().id)}
                  />
                )}
              </Each>
            </>
          }
        >
          <View
            style={{
              padding: 16,
              gap: 8,
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
            <Label size={12} tone="muted">
              {uiText("agentsRunOnThatMachineWith")}
            </Label>
          </View>
        </If>
        <Each of={pending() ? [] : candidates()} key={(item) => item.id}>
          {(item) => <MachineTaskSubscription id={item().id} />}
        </Each>
        <If
          when={
            props.item.kind !== "primary" && props.item.status !== "revoked"
          }
        >
          <View style={rowStyle()}>
            <Label style={{ flex: 1 }}>{uiText("removeMachine")}</Label>
            <Button
              label={uiText("remove2")}
              onPress={() => removing.set(true)}
            />
          </View>
        </If>
        <If when={props.item.updateError}>
          <Label tone="red" size={12} style={{ padding: 16 }}>
            {props.item.updateError}
          </Label>
        </If>
      </Scroll>
      <If when={pending() || upgrade()}>
        <View
          style={{
            paddingHorizontal: 16,
            paddingVertical: 8,
            borderTopWidth: 1,
            borderColor: c().border,
          }}
        >
          <If
            when={pending()}
            else={
              <Button
                label={uiText("updateMachine")}
                tone="primary"
                disabled={busy()}
                onPress={() =>
                  void act(() =>
                    host.call("machines", "upgrade", {
                      machineId: props.item.id,
                    }),
                  )
                }
              />
            }
          >
            <Button
              label={uiText("approve")}
              tone="primary"
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
        <Modal
          title={uiText("taskRunsAtOnce")}
          phone={props.phone}
          sheet={props.phone}
          onClose={() => editing.set(false)}
        >
          <View style={{ padding: 16, gap: 8 }}>
            <Label size={12} tone="muted">
              {uiText("chooseHowManyTaskRunsCan")}
            </Label>
            <Field
              label={uiText("maximumTaskRuns")}
              value={limit()}
              onChange={limit.set}
            />
            <Button
              label={uiText("saveLimit")}
              tone="primary"
              disabled={busy() || !/^(?:[1-9]|1\d|20)$/.test(limit().trim())}
              onPress={() =>
                void act(
                  () =>
                    host.call("machines", "setMaxActiveRuns", {
                      machineId: props.item.id,
                      maxActiveRuns: Number(limit().trim()),
                    }),
                  () => editing.set(false),
                )
              }
            />
          </View>
        </Modal>
      </If>
      <If when={removing()}>
        <Modal
          title={uiText("removeMachine2")}
          phone={props.phone}
          sheet={props.phone}
          onClose={() => removing.set(false)}
        >
          <View style={{ padding: 16, gap: 8 }}>
            <Label>
              {uiText("willNoLongerBeAbleTo", { name: props.item.name })}
            </Label>
            <Button
              label={uiText("removeMachine")}
              tone="danger"
              disabled={busy()}
              onPress={() =>
                void act(
                  () =>
                    host.call("machines", "revoke", {
                      machineId: props.item.id,
                    }),
                  props.onClose,
                )
              }
            />
          </View>
        </Modal>
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
