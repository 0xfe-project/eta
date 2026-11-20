import type { DirectoryChoice } from "./use-place-flow";
import { View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  colors,
  Field,
  grow,
  Icon,
  Label,
  row,
} from "../../components";
import { AgentFace } from "../../components/agent-face";
import { CheckControl } from "../../components/check-control";
import { localizedText, uiText } from "../../i18n";
import { useHost } from "../../services/host";

export function ConversationMembers(props: {
  directory: DirectoryChoice;
  machineName: string;
  phone: boolean;
  agentIds: string[];
  advanced: boolean;
  name: string;
  stewardId: string | null | undefined;
  onToggleAgent: (id: string) => void;
  onName: (name: string) => void;
  onSteward: (id: string | null) => void;
  onStart: () => void;
}) {
  const host = useHost();
  const c = colors();
  return (
    <>
      <View style={{ ...row, gap: 8, marginHorizontal: 16, marginTop: 10 }}>
        <Icon name="folder" size={14} />
        <Label
          size={12}
          lines={1}
        >{`${props.directory.name ?? host.projects().find((project) => project.id === props.directory.projectId)?.name ?? props.directory.display} · ${props.machineName}`}</Label>
      </View>
      <Label
        tone="muted"
        size={14}
        style={{ paddingHorizontal: 16, paddingVertical: 7 }}
      >
        {localizedText(
          "Who should work in this conversation?",
          "谁来参与这次对话？",
        )}
      </Label>
      <Each of={host.agents()} key={(agent) => agent.id}>
        {(agent) => {
          const checked = () => props.agentIds.includes(agent().id);
          return (
            <CheckControl
              label={agent().name}
              checked={checked()}
              onChange={() => props.onToggleAgent(agent().id)}
              hoverStyle={{ backgroundColor: c().selected }}
              size={13}
              indicatorStyle={{ borderColor: checked() ? c().ink : c().strong }}
              style={{
                ...row,
                height: props.phone ? 52 : 34,
                gap: 12,
                marginHorizontal: 16,
                paddingHorizontal: 4,
                borderBottomWidth: 1,
                borderColor: c().border,
                cursor: "pointer",
              }}
            >
              <AgentFace id={agent().id} size={24} />
              <Label style={grow}>{agent().name}</Label>
              <Label size={11} tone="muted">
                {agent().runtime === "claude"
                  ? "Claude Code"
                  : agent().runtime === "codex"
                    ? "Codex"
                    : agent().runtime === "eta" || !agent().runtime
                      ? localizedText("eta (built-in)", "eta（内置）")
                      : agent().runtime}
              </Label>
            </CheckControl>
          );
        }}
      </Each>
      <If when={!host.agents().length}>
        <Label tone="muted" style={{ padding: 16 }}>
          {uiText("createAnAgentFirstInSettings")}
        </Label>
      </If>
      <If when={props.advanced}>
        <View style={{ marginHorizontal: 16, marginTop: 14, gap: 10 }}>
          <Field
            label={uiText("conversationName")}
            placeholder={uiText("conversationNameOptional")}
            value={props.name}
            onChange={props.onName}
            onSubmit={props.onStart}
          />
          <View style={{ ...row, gap: 8 }}>
            <Label size={12} tone="muted">
              {uiText("steward2")}
            </Label>
            <ActionMenu
              label={uiText("steward2")}
              value={
                props.stewardId
                  ? host.agent(props.stewardId)?.name
                  : uiText("noSteward")
              }
            >
              <Each of={props.agentIds}>
                {(id) => (
                  <ActionItem
                    label={host.agent(id())?.name ?? id()}
                    checked={props.stewardId === id()}
                    onSelect={() => props.onSteward(id())}
                  />
                )}
              </Each>
              <ActionItem
                label={uiText("noSteward")}
                checked={props.stewardId === null}
                onSelect={() => props.onSteward(null)}
              />
            </ActionMenu>
          </View>
        </View>
      </If>
    </>
  );
}
