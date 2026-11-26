import type { MachineResults, MachineView } from "@eta/client-contracts";
import { cleanup, signal, View } from "nsh";
import {
  Button,
  colors,
  dialogWidth,
  Label,
  Modal,
  row,
  SmoothScroll,
} from "../../../components";
import { FieldDialog } from "../../../components/field-dialog";
import { space, weight } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { problemText } from "../../../services/problem-text";

/** Maximum height of the scrollable preview summary inside the remove-machine confirmation modal. */
const previewMaxHeight = 240;

export function RenameMachine(props: {
  item: MachineView;
  phone: boolean;
  onClose: () => void;
}) {
  const host = useHost();
  const name = signal(props.item.name);
  const busy = signal(false);
  const valid = () => !!name().trim() && name().trim() !== props.item.name;
  async function save() {
    if (busy() || !valid()) return;
    busy.set(true);
    const result = await host.action(() =>
      host.call("machines", "rename", {
        machineId: props.item.id,
        name: name().trim(),
      }),
    );
    busy.set(false);
    if (result !== undefined) props.onClose();
  }
  return (
    <FieldDialog
      title={uiText("machineRenameTitle", { name: props.item.name })}
      label={uiText("machineName")}
      value={name()}
      phone={props.phone}
      busy={busy()}
      valid={valid()}
      onChange={name.set}
      onSave={() => void save()}
      onClose={props.onClose}
    />
  );
}

export function MachineRunsLimit(props: {
  item: MachineView;
  phone: boolean;
  onClose: () => void;
}) {
  const host = useHost();
  const limit = signal(String(props.item.maxActiveRuns));
  const busy = signal(false);
  const valid = () =>
    /^(?:[1-9]|1\d|20)$/.test(limit().trim()) &&
    Number(limit().trim()) !== props.item.maxActiveRuns;
  async function save() {
    if (busy() || !valid()) return;
    busy.set(true);
    const result = await host.action(() =>
      host.call("machines", "setMaxActiveRuns", {
        machineId: props.item.id,
        maxActiveRuns: Number(limit().trim()),
      }),
    );
    busy.set(false);
    if (result !== undefined) props.onClose();
  }
  return (
    <FieldDialog
      title={uiText("machineRunsTitle", { name: props.item.name })}
      label={uiText("maximumTaskRuns")}
      value={limit()}
      phone={props.phone}
      busy={busy()}
      valid={valid()}
      description={
        <If when={props.phone}>
          <Label variant="small" tone="muted">
            {uiText("machineRunsField")}
          </Label>
        </If>
      }
      onChange={limit.set}
      onSave={() => void save()}
      onClose={props.onClose}
    />
  );
}

/** Permanently removing a machine previews every affected agent, project, chat, and active run first. */
export function RemoveMachine(props: {
  item: MachineView;
  phone: boolean;
  onClose: () => void;
  onRemoved?: () => void;
}) {
  const host = useHost();
  const c = colors();
  const busy = signal(false);
  const loading = signal(true);
  const error = signal<string | undefined>(undefined);
  const preview = signal<MachineResults["removePreview"] | undefined>(
    undefined,
  );

  let alive = true;
  cleanup(() => {
    alive = false;
  });

  void host
    .call<MachineResults["removePreview"]>("machines", "removePreview", {
      machineId: props.item.id,
    })
    .then(
      (result) => {
        if (!alive) return;
        preview.set(result);
        loading.set(false);
      },
      (failure: unknown) => {
        if (!alive) return;
        error.set(problemText(failure));
        loading.set(false);
      },
    );

  const hasDependents = () => {
    const p = preview();
    if (!p) return false;
    return (
      p.agents.length > 0 ||
      p.projects.length > 0 ||
      p.conversations.length > 0 ||
      p.activeRuns > 0 ||
      p.activeReplies > 0
    );
  };

  async function remove() {
    if (busy() || loading() || error()) return;
    busy.set(true);
    const result = await host.action(() =>
      host.call("machines", "remove", { machineId: props.item.id }),
    );
    busy.set(false);
    if (result !== undefined) {
      props.onClose();
      props.onRemoved?.();
    }
  }

  return (
    <Modal
      title={uiText("removeMachine2")}
      phone={props.phone}
      sheet={props.phone}
      width={props.phone ? undefined : dialogWidth.md}
      modalFocus
      overPhoneNavigation
      onClose={() => {
        if (!busy()) props.onClose();
      }}
    >
      <View style={{ padding: space[16], gap: space[12] }}>
        <Label>
          {uiText("removeMachineWarning", { name: props.item.name })}
        </Label>
        <If when={loading()}>
          <Label variant="small" tone="muted">
            {uiText("removeMachineLoading")}
          </Label>
        </If>
        <If when={error()}>
          {(message) => (
            <Label variant="small" tone="red">
              {message()}
            </Label>
          )}
        </If>
        <If when={!loading() && !error()}>
          <If when={preview()}>
            {(data) => (
              <If
                when={hasDependents()}
                else={
                  <Label variant="small" tone="muted">
                    {uiText("removeMachineNoDependents")}
                  </Label>
                }
              >
                <SmoothScroll style={{ maxHeight: previewMaxHeight }}>
                  <View
                    style={{
                      padding: space[12],
                      gap: space[8],
                      backgroundColor: c().selected,
                    }}
                  >
                    <If when={data().agents.length > 0}>
                      <View style={{ gap: space[4] }}>
                        <Label
                          variant="caption"
                          weight={weight.strong}
                          tone="mutedInk"
                        >
                          {uiText("removeMachineAgents", {
                            count: data().agents.length,
                          })}
                        </Label>
                        <Each of={data().agents} key={(agent) => agent.id}>
                          {(agent) => (
                            <Label variant="small">
                              {agent().runtime === "eta"
                                ? uiText("removeMachineAgentPinnedEta", {
                                    name: agent().name,
                                  })
                                : uiText("removeMachineAgentExternal", {
                                    name: agent().name,
                                    runtime: agent().runtime,
                                  })}
                            </Label>
                          )}
                        </Each>
                      </View>
                    </If>
                    <If when={data().projects.length > 0}>
                      <View style={{ gap: space[4] }}>
                        <Label
                          variant="caption"
                          weight={weight.strong}
                          tone="mutedInk"
                        >
                          {uiText("removeMachineProjects", {
                            count: data().projects.length,
                          })}
                        </Label>
                        <Each
                          of={data().projects}
                          key={(project) => project.id}
                        >
                          {(project) => (
                            <Label variant="small">
                              {`${project().name} (${project().path})`}
                            </Label>
                          )}
                        </Each>
                      </View>
                    </If>
                    <If when={data().conversations.length > 0}>
                      <View style={{ gap: space[4] }}>
                        <Label
                          variant="caption"
                          weight={weight.strong}
                          tone="mutedInk"
                        >
                          {uiText("removeMachineConversations", {
                            count: data().conversations.length,
                          })}
                        </Label>
                        <Each
                          of={data().conversations}
                          key={(conversation) => conversation.id}
                        >
                          {(conversation) => (
                            <Label variant="small">
                              {conversation().archived
                                ? uiText("removeMachineArchivedTag", {
                                    name: conversation().name,
                                  })
                                : conversation().name}
                            </Label>
                          )}
                        </Each>
                      </View>
                    </If>
                    <If
                      when={data().activeRuns > 0 || data().activeReplies > 0}
                    >
                      <Label variant="small" tone="warning">
                        {uiText("removeMachineActiveWork", {
                          runs: data().activeRuns,
                          replies: data().activeReplies,
                        })}
                      </Label>
                    </If>
                  </View>
                </SmoothScroll>
              </If>
            )}
          </If>
        </If>
        <View style={{ ...row, justifyContent: "flex-end", gap: space[8] }}>
          <Button
            label={uiText("cancel")}
            disabled={busy()}
            onPress={props.onClose}
          />
          <Button
            label={busy() ? uiText("removing") : uiText("removeMachine")}
            tone="danger"
            busy={busy()}
            disabled={busy() || loading() || !!error()}
            onPress={() => void remove()}
          />
        </View>
      </View>
    </Modal>
  );
}
