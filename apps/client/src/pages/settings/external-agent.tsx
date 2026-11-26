import type {
  AcpAgentView,
  AcpDeletePreview,
  AcpTestResult,
  MachineView,
} from "@eta/client-contracts";
import { signal, View } from "nsh";
import {
  Button,
  colors,
  dialogWidth,
  grow,
  Label,
  Modal,
  row,
} from "../../components";
import { BackButton } from "../../components/navigation-buttons";
import { StatusDot } from "../../components/status-dot";
import { control, icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { problemText } from "../../services/problem-text";
import { LetterBox } from "./section";

/** The detail's body off phones, and the label column of its facts. */
const bodyMinHeight = 240;
const labelWidth = 84;

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
  /** Whether its machine answers now; an offline machine's agent can't be edited. */
  writable?: boolean;
  /** Opens the edit form; absent when this client may not change agents. */
  onEdit?: () => void;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const testing = signal(false);
  const removing = signal(false);
  const confirm = signal(false);
  const preview = signal<AcpDeletePreview | undefined>(undefined);
  const previewLoading = signal(false);
  const previewError = signal<string | undefined>(undefined);
  let previewRequest = 0;
  const result = signal<AcpTestResult | undefined>(undefined);
  const status = () => result()?.status ?? props.agent.status;
  const machineName = () =>
    props.machine
      ? `${props.machine.name}${props.machine.kind === "primary" ? " (primary)" : ""}`
      : "Host";
  const hasDependents = () => (preview()?.agents.length ?? 0) > 0;
  function openRemoveConfirm() {
    const seq = ++previewRequest;
    confirm.set(true);
    preview.set(undefined);
    previewError.set(undefined);
    if (!host.can("acp.deletePreview")) {
      preview.set({
        id: props.agent.id,
        machineId: props.machineId,
        agents: [],
      });
      previewLoading.set(false);
      return;
    }
    previewLoading.set(true);
    void host
      .call<AcpDeletePreview>("acp", "deletePreview", {
        machineId: props.machineId,
        id: props.agent.id,
      })
      .then(
        (answer) => {
          if (seq !== previewRequest) return;
          preview.set(answer);
          previewLoading.set(false);
        },
        (failure: unknown) => {
          if (seq !== previewRequest) return;
          previewError.set(problemText(failure));
          previewLoading.set(false);
        },
      );
  }
  function closeRemoveConfirm() {
    if (removing()) return;
    previewRequest += 1;
    confirm.set(false);
  }
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
    if (removing() || previewLoading() || previewError()) return;
    removing.set(true);
    const answer = await host.action(() =>
      host.call("acp", "delete", {
        machineId: props.machineId,
        id: props.agent.id,
        ...(hasDependents() ? { deleteAgents: true } : {}),
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
            height: space[48],
            flexShrink: 0,
            gap: space[4],
            paddingHorizontal: space[8],
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <BackButton
            size={control.touch}
            iconSize={icon.md}
            onPress={props.onClose}
          />
          <View style={{ ...row, flex: 1, minWidth: 0, gap: space[4] }}>
            <LetterBox name={props.agent.label} />
            <Label weight={weight.strong} lines={1} style={{ flex: 1 }}>
              {props.agent.label}
            </Label>
          </View>
          <If
            when={props.onEdit && props.writable !== false}
            else={
              <View
                style={{ width: space[40], height: space[40], flexShrink: 0 }}
              />
            }
          >
            <Button
              label={uiText("settingsEdit")}
              size={control.md}
              style={{ paddingHorizontal: space[12], flexShrink: 0 }}
              disabled={testing() || removing()}
              onPress={() => props.onEdit?.()}
            />
          </If>
        </View>
      </If>
      <View
        style={{ ...grow, minHeight: props.phone ? undefined : bodyMinHeight }}
      >
        <View
          style={{
            ...row,
            minHeight: control.touch,
            paddingHorizontal: space[16],
            paddingVertical: space[8],
            borderBottomWidth: 1,
            borderColor: c().border,
            gap: space[4],
          }}
        >
          <StatusDot
            color={status() === "available" ? c().green : c().warning}
          />
          <Label variant="small" tone="mutedInk">
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
                paddingHorizontal: space[16],
                paddingVertical: space[8],
                minHeight: control.touch,
                borderBottomWidth: 1,
                borderColor: c().border,
                gap: props.phone ? space[16] : space[8],
              }}
            >
              <Label
                style={
                  props.phone
                    ? { flexShrink: 0 }
                    : { width: labelWidth, flexShrink: 0 }
                }
              >
                {item()[0]}
              </Label>
              <Label
                variant="small"
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
              paddingHorizontal: space[16],
              paddingVertical: space[8],
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label
              variant="small"
              tone={status() === "available" ? "muted" : "warning"}
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
        <If when={!props.phone && props.onEdit && props.writable !== false}>
          <View
            style={{
              ...row,
              minHeight: control.touch,
              gap: space[16],
              paddingHorizontal: space[16],
              paddingVertical: space[8],
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label style={{ flex: 1 }}>{uiText("acpEditAgent")}</Label>
            <Button
              label={uiText("settingsEdit")}
              style={{ gap: space[4], paddingHorizontal: space[12] }}
              disabled={testing() || removing()}
              onPress={() => props.onEdit?.()}
            />
          </View>
        </If>
        <If when={host.can("acp.delete")}>
          <View
            style={{
              ...row,
              minHeight: control.touch,
              gap: space[16],
              paddingHorizontal: space[16],
              paddingVertical: space[8],
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label style={{ flex: 1 }}>{uiText("removeAgent")}</Label>
            <Button
              label={uiText("remove2")}
              icon="archive"
              style={{ gap: space[4], paddingHorizontal: space[12] }}
              disabled={testing()}
              onPress={openRemoveConfirm}
            />
          </View>
        </If>
        <View style={{ flex: 1 }} />
        <If when={host.can("acp.test")}>
          <View
            style={{
              paddingHorizontal: space[16],
              paddingVertical: props.phone ? space[12] : space[16],
              borderTopWidth: 1,
              borderColor: c().border,
            }}
          >
            <Button
              label={uiText("test")}
              tone="primary"
              size={props.phone ? control.touch : control.lg}
              busy={testing()}
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
          sheet={props.phone}
          width={props.phone ? undefined : dialogWidth.md}
          modalFocus
          overPhoneNavigation
          onClose={closeRemoveConfirm}
        >
          <View style={{ padding: space[16], gap: space[12] }}>
            <Label>
              {uiText("removeFromWithCount", {
                label: props.agent.label,
                machineName: machineName(),
              })}
            </Label>
            <If when={previewLoading()}>
              <Label variant="small" tone="muted">
                {uiText("acpRemovePreviewLoading")}
              </Label>
            </If>
            <If when={previewError()}>
              {(message) => (
                <Label variant="small" tone="red">
                  {message()}
                </Label>
              )}
            </If>
            <If when={!previewLoading() && !previewError() && hasDependents()}>
              <View
                style={{
                  padding: space[12],
                  gap: space[8],
                  backgroundColor: c().selected,
                }}
              >
                <Label variant="small" tone="warning">
                  {uiText("acpRemoveCascadeWarning", {
                    count: preview()?.agents.length ?? 0,
                  })}
                </Label>
                <Each
                  of={preview()?.agents ?? []}
                  key={(dependent) => dependent.id}
                >
                  {(dependent) => (
                    <Label variant="small">
                      {`${
                        dependent().groupCount > 0
                          ? uiText("acpRemoveAgentInGroups", {
                              name: dependent().name,
                              count: dependent().groupCount,
                            })
                          : dependent().name
                      }${dependent().busy ? uiText("acpRemoveAgentBusySuffix") : ""}`}
                    </Label>
                  )}
                </Each>
              </View>
            </If>
            <View style={{ ...row, justifyContent: "flex-end", gap: space[8] }}>
              <Button
                label={uiText("cancel")}
                disabled={removing()}
                onPress={closeRemoveConfirm}
              />
              <Button
                label={
                  removing()
                    ? uiText("removing")
                    : hasDependents()
                      ? uiText("acpRemoveAndDeleteAgents")
                      : uiText("remove2")
                }
                tone="danger"
                busy={removing()}
                disabled={removing() || previewLoading() || !!previewError()}
                onPress={() => void remove()}
              />
            </View>
          </View>
        </Modal>
      </If>
    </Modal>
  );
}
