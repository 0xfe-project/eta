import type { MachineView } from "@eta/client-contracts";
import type { DirectoryChoice } from "./use-place-flow";
import { View } from "nsh";
import { Button, colors, grow, Icon, Label, row } from "../../components";
import { AgentFace } from "../../components/agent-face";
import { CheckControl } from "../../components/check-control";
import { EmptyState } from "../../components/empty-state";
import {
  avatar,
  control,
  icon,
  opacity,
  space,
  weight,
} from "../../components/tokens";
import { localizedText, uiText } from "../../i18n";
import { onlyOnMachineNote } from "../../services/agent-machine";
import { useHost } from "../../services/host";
import { useLoadState } from "../../services/load-status";

/** A member row: a finger's row on phones, a list row elsewhere. */
const memberRowHeight = { phone: 52, desktop: 36 } as const;

/** The steward's slot at the end of a row, kept when unticked so the columns line up. */
const stewardColumnWidth = 104;

export function ConversationMembers(props: {
  directory: DirectoryChoice;
  machineName: string;
  phone: boolean;
  agentIds: string[];
  stewardId: string | null | undefined;
  onToggleAgent: (id: string) => void;
  onSteward: (id: string | null) => void;
}) {
  const host = useHost();
  const load = useLoadState({ targets: () => ["agents"] });
  const c = colors();
  const machines = () => host.list<MachineView>("machines");
  return (
    <>
      <View
        style={{
          ...row,
          gap: space[8],
          marginHorizontal: space[16],
          marginTop: space[12],
          height: props.phone ? space[32] : undefined,
        }}
      >
        <Icon name="folder" size={icon.md} />
        <Label
          variant="small"
          lines={1}
        >{`${props.directory.name ?? host.projects().find((project) => project.id === props.directory.projectId)?.name ?? props.directory.display} · ${props.machineName}`}</Label>
      </View>
      <Label
        tone="muted"
        style={{
          paddingHorizontal: space[16],
          paddingTop: space[4],
          paddingBottom: space[8],
        }}
      >
        {localizedText(
          "Who should work in this conversation?",
          "谁来参与这次对话？",
        )}
      </Label>
      <Each of={host.agents()} key={(agent) => agent.id}>
        {(agent, index) => {
          const note = () =>
            onlyOnMachineNote(agent(), props.directory.machineId, machines());
          const disabled = () => note() !== undefined;
          const checked = () =>
            !disabled() && props.agentIds.includes(agent().id);
          const steward = () => !disabled() && props.stewardId === agent().id;
          return (
            <View
              style={{
                ...row,
                height: props.phone
                  ? memberRowHeight.phone
                  : memberRowHeight.desktop,
                gap: space[12],
                marginHorizontal: space[16],
                paddingRight: space[4],
                borderTopWidth: index() === 0 ? 1 : 0,
                borderBottomWidth: 1,
                borderColor: c().border,
              }}
            >
              <CheckControl
                label={agent().name}
                checked={checked()}
                disabled={disabled()}
                onChange={() => {
                  if (!disabled()) props.onToggleAgent(agent().id);
                }}
                hoverStyle={{ backgroundColor: c().selected }}
                size={icon.md}
                indicatorStyle={{
                  borderColor: checked() ? c().ink : c().strong,
                }}
                style={{
                  ...row,
                  ...grow,
                  alignSelf: "stretch",
                  gap: space[12],
                  paddingHorizontal: space[4],
                  cursor: disabled() ? "default" : "pointer",
                  ...(disabled() ? { opacity: opacity.disabled } : {}),
                }}
              >
                <AgentFace id={agent().id} size={avatar.md} />
                <Label style={grow} lines={1}>
                  {agent().name}
                </Label>
                <Label variant="caption" tone="muted">
                  {note() ??
                    (agent().runtime === "claude"
                      ? "Claude Code"
                      : agent().runtime === "codex"
                        ? "Codex"
                        : agent().runtime === "eta" || !agent().runtime
                          ? localizedText("eta (built-in)", "eta（内置）")
                          : agent().runtime)}
                </Label>
              </CheckControl>
              {/* The steward is chosen on its own row; pressed again, the
                  group has none. Unticked rows keep the slot so the columns
                  line up. */}
              <View
                style={{
                  ...row,
                  justifyContent: "flex-end",
                  width: stewardColumnWidth,
                  flexShrink: 0,
                }}
              >
                <If when={checked()}>
                  <Button
                    label={uiText(steward() ? "steward2" : "makeSteward")}
                    tone={steward() ? "primary" : "ghost"}
                    selected={steward()}
                    labelWeight={weight.regular}
                    size={props.phone ? control.md : control.sm}
                    style={{ paddingHorizontal: space[12] }}
                    onPress={() =>
                      props.onSteward(steward() ? null : agent().id)
                    }
                  />
                </If>
              </View>
            </View>
          );
        }}
      </Each>
      <If when={!host.agents().length}>
        <EmptyState
          size="row"
          status={load.shown()}
          loading={uiText("loadingAgents")}
          error={{
            title: uiText("agentsDidNotLoad"),
            retry: load.retry,
            retrying: load.retrying(),
          }}
          empty={{ title: uiText("createAnAgentFirstInSettings") }}
          style={{ padding: space[16] }}
        />
      </If>
    </>
  );
}
