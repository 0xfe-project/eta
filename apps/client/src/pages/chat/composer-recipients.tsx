import type { MemberView } from "@eta/client-contracts";
import { View } from "nsh";
import { colors, Icon, Label, row } from "../../components";
import { AgentFace } from "../../components/agent-face";
import { StatusDot } from "../../components/status-dot";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

export function ComposerRecipients(props: {
  phone: boolean;
  members: MemberView[];
  steward?: string | null;
  mentions: string[] | null;
  recipients: string[];
  running: boolean;
  names: string;
  mode: "steer" | "queue";
  onChangeMentions: (mentions: string[] | null) => void;
  onToggleRecipient: (agentId: string) => void;
}) {
  const c = colors();
  const host = useHost();
  return (
    <View
      style={{
        flexDirection: props.phone ? "column-reverse" : "row",
        alignItems: props.phone ? "flex-start" : "center",
        justifyContent: "space-between",
        gap: 5,
      }}
    >
      <View style={{ ...row, gap: 6, flexWrap: "wrap" }}>
        <View
          role="button"
          accessibilityLabel={uiText("everyone")}
          accessibilityState={{
            selected: props.mentions?.length === props.members.length,
          }}
          onPress={() =>
            props.onChangeMentions(
              props.mentions?.length === props.members.length
                ? null
                : props.members.map((member) => member.agentId),
            )
          }
          hoverStyle={{ backgroundColor: c().selected }}
          style={{
            ...row,
            height: 28,
            gap: 6,
            paddingLeft: 8,
            paddingRight: 10,
            borderWidth: 1,
            borderColor: c().border,
            backgroundColor: c().surface,
            cursor: "pointer",
          }}
        >
          <View
            style={{
              ...row,
              justifyContent: "center",
              width: 14,
              height: 14,
              borderWidth: 1,
              borderColor: c().strong,
            }}
          >
            <If when={props.mentions?.length === props.members.length}>
              <Icon name="check" size={10} />
            </If>
          </View>
          <Label size={12} line={16} tone="mutedInk">
            {uiText("everyone")}
          </Label>
        </View>
        <Each of={props.members} key={(member) => member.agentId}>
          {(member) => (
            <View
              role="button"
              accessibilityLabel={
                host.agent(member().agentId)?.name ?? uiText("agent")
              }
              accessibilityState={{
                selected: props.recipients.includes(member().agentId),
              }}
              onPress={() => props.onToggleRecipient(member().agentId)}
              hoverStyle={{ backgroundColor: c().selected }}
              style={{
                ...row,
                height: 28,
                gap: 6,
                paddingLeft: 6,
                paddingRight: 10,
                borderWidth: 1,
                borderColor: props.recipients.includes(member().agentId)
                  ? c().ink
                  : c().border,
                cursor: "pointer",
                backgroundColor: props.recipients.includes(member().agentId)
                  ? c().canvas
                  : c().surface,
              }}
            >
              <AgentFace id={member().agentId} size={16} />
              <Label
                size={12}
                line={16}
                lines={1}
                tone={
                  props.recipients.includes(member().agentId)
                    ? "ink"
                    : "mutedInk"
                }
                weight={props.recipients.includes(member().agentId) ? 600 : 400}
              >
                {host.agent(member().agentId)?.name ?? uiText("agent")}
              </Label>
              <If when={!props.phone && member().agentId === props.steward}>
                <Label size={10} tone="muted">
                  {uiText("steward")}
                </Label>
              </If>
            </View>
          )}
        </Each>
      </View>
      <View style={{ ...row, gap: 6 }}>
        <StatusDot color={props.running ? c().blue : c().green} />
        <Label size={12} line={16} tone="muted">
          {props.names
            ? props.running
              ? `${props.names} · ${uiText(props.mode === "steer" ? "steer" : "queue")}`
              : uiText(
                  props.recipients.length > 1
                    ? "recipientsReply"
                    : "recipientReplies",
                  {
                    names: props.names,
                  },
                )
            : uiText("chooseWhoShouldReply")}
        </Label>
      </View>
    </View>
  );
}
