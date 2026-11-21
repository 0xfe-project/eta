import type {
  AcpAgentView,
  AcpTestResult,
  MachineView,
} from "@eta/client-contracts";
import { signal, View } from "nsh";
import { Button, colors, grow, Label, Modal, row } from "../../components";
import { BackButton } from "../../components/navigation-buttons";
import { StatusDot } from "../../components/status-dot";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { LetterBox } from "./section";

export const acpStatus = {
  available: "externalAgentAvailable",
  unauthenticated: "externalAgentUnauthenticated",
  missing: "externalAgentMissing",
  error: "needsAttention",
} as const satisfies Record<
  AcpAgentView["status"],
  Parameters<typeof uiText>[0]
>;

export function ExternalAgentDetail(props: {
  agent: AcpAgentView;
  machineId: string;
  machine?: MachineView;
  phone: boolean;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const testing = signal(false);
  const removing = signal(false);
  const confirm = signal(false);
  const result = signal<AcpTestResult | undefined>(undefined);
  const status = () => result()?.status ?? props.agent.status;
  const machineName = () =>
    props.machine
      ? `${props.machine.name}${props.machine.kind === "primary" ? " (primary)" : ""}`
      : "Host";
  async function test() {
    if (testing()) return;
    testing.set(true);
    const { id, label, command, args, env } = props.agent;
    const answer = await host.action(() =>
      host.call<AcpTestResult>("acp", "test", {
        machineId: props.machineId,
        agent: { id, label, command, args, env },
      }),
    );
    if (answer) result.set(answer);
    testing.set(false);
  }
  async function remove() {
    if (removing()) return;
    removing.set(true);
    const answer = await host.action(() =>
      host.call("acp", "delete", {
        machineId: props.machineId,
        id: props.agent.id,
      }),
    );
    removing.set(false);
    if (answer) props.onClose();
  }
  return (
    <Modal
      title={props.agent.label}
      phone={props.phone}
      phonePage={props.phone}
      hideHeader={props.phone}
      height={props.phone ? "100%" : undefined}
      onClose={props.onClose}
    >
      <If when={props.phone}>
        <View
          style={{
            ...row,
            height: 48,
            flexShrink: 0,
            gap: 4,
            paddingHorizontal: 8,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <BackButton size={40} iconSize={16} onPress={props.onClose} />
          <View style={{ ...row, flex: 1, minWidth: 0, gap: 4 }}>
            <LetterBox name={props.agent.label} />
            <Label line={20} weight={600} lines={1} style={{ flex: 1 }}>
              {props.agent.label}
            </Label>
          </View>
          <View style={{ width: 40, height: 40, flexShrink: 0 }} />
        </View>
      </If>
      <View style={{ ...grow, minHeight: props.phone ? undefined : 240 }}>
        <View
          style={{
            ...row,
            minHeight: 44,
            paddingHorizontal: 16,
            paddingVertical: 8,
            borderBottomWidth: 1,
            borderColor: c().border,
            gap: 6,
          }}
        >
          <StatusDot color={status() === "available" ? c().green : c().amber} />
          <Label size={12} line={16} tone="mutedInk">
            {uiText(acpStatus[status()])}
          </Label>
        </View>
        <Each
          of={[
            [uiText("runtime"), props.agent.runtime],
            [uiText("externalAgentMachine"), machineName()],
            [
              uiText("externalAgentCommand"),
              [props.agent.command, ...props.agent.args].join(" "),
            ],
          ]}
        >
          {(item) => (
            <View
              style={{
                ...row,
                paddingHorizontal: 16,
                paddingVertical: 8,
                minHeight: 44,
                borderBottomWidth: 1,
                borderColor: c().border,
                gap: props.phone ? 16 : 8,
              }}
            >
              <Label
                line={20}
                style={
                  props.phone ? { flexShrink: 0 } : { width: 82, flexShrink: 0 }
                }
              >
                {item()[0]}
              </Label>
              <Label
                size={12}
                tone="muted"
                lines={2}
                style={{ flex: 1, minWidth: 0, textAlign: "right" }}
              >
                {item()[1]}
              </Label>
            </View>
          )}
        </Each>
        <If
          when={
            result()?.detail ||
            props.agent.detail ||
            status() === "unauthenticated"
          }
        >
          <View
            style={{
              paddingHorizontal: 16,
              paddingVertical: 8,
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label
              size={12}
              line={16}
              tone={status() === "available" ? "muted" : "amber"}
            >
              {result()?.detail ??
                props.agent.detail ??
                uiText("signInToOnThenChoose", {
                  label: props.agent.label,
                  machineName: machineName(),
                })}
            </Label>
          </View>
        </If>
        <If when={host.can("acp.delete")}>
          <View
            style={{
              ...row,
              minHeight: 44,
              gap: 16,
              paddingHorizontal: 16,
              paddingVertical: 8,
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label line={20} style={{ flex: 1 }}>
              {uiText("removeAgent")}
            </Label>
            <Button
              label={uiText("remove2")}
              icon="archive"
              style={{ gap: 6, paddingHorizontal: 10 }}
              disabled={testing()}
              onPress={() => confirm.set(true)}
            />
          </View>
        </If>
        <View style={{ flex: 1 }} />
        <If when={host.can("acp.test")}>
          <View
            style={{
              paddingHorizontal: 16,
              paddingVertical: props.phone ? 12 : 16,
              borderTopWidth: 1,
              borderColor: c().border,
            }}
          >
            <Button
              label={testing() ? uiText("testing") : uiText("test")}
              tone="primary"
              size={props.phone ? 32 : 36}
              disabled={testing()}
              style={{ width: "100%", justifyContent: "center" }}
              onPress={() => void test()}
            />
          </View>
        </If>
      </View>
      <If when={confirm()}>
        <Modal
          title={uiText("removeExternalAgent")}
          phone={props.phone}
          onClose={() => confirm.set(false)}
        >
          <View style={{ padding: 16, gap: 10 }}>
            <Label>
              {uiText("removeFromWithCount", {
                label: props.agent.label,
                machineName: machineName(),
              })}
            </Label>
            <Button
              label={removing() ? uiText("removing") : uiText("remove2")}
              disabled={removing()}
              onPress={() => void remove()}
            />
          </View>
        </Modal>
      </If>
    </Modal>
  );
}
