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
  /** The members whose reply is still running. */
  running: string[];
  /** How many of the user's messages wait for a running reply to end. */
  held: number;
  names: string;
  /** The recipients a new message would wait for, by name. */
  waitsFor: string;
  onChangeMentions: (mentions: string[] | null) => void;
  onToggleRecipient: (agentId: string) => void;
  onToggleHeld: () => void;
  onStop: (agentId: string) => void;
}) {
  const c = colors();
  const host = useHost();
  const everyone = () => props.mentions?.length === props.members.length;
  // The queued count sits on the first running chip only.
  const heldOn = () =>
    props.running.find((id) =>
      props.members.some((member) => member.agentId === id),
    );
  return (
    <View
      style={{
        flexDirection: props.phone ? "column-reverse" : "row",
        alignItems: props.phone ? "flex-start" : "center",
        justifyContent: "space-between",
        gap: 6,
      }}
    >
      <View style={{ ...row, gap: 6, flexWrap: "wrap" }}>
        <View
          role="button"
          accessibilityLabel={uiText("everyone")}
          accessibilityState={{ selected: everyone() }}
          onPress={() =>
            props.onChangeMentions(
              everyone() ? null : props.members.map((member) => member.agentId),
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
              backgroundColor: c().canvas,
            }}
          >
            <If when={everyone()}>
              <Icon name="check" size={10} />
            </If>
          </View>
          <Label size={12} line={16} tone="mutedInk">
            {uiText("everyone")}
          </Label>
        </View>
        <Each of={props.members} key={(member) => member.agentId}>
          {(member) => {
            const id = () => member().agentId;
            const selected = () => props.recipients.includes(id());
            const running = () => props.running.includes(id());
            const name = () => host.agent(id())?.name ?? uiText("agent");
            return (
              <View
                role="button"
                accessibilityLabel={name()}
                accessibilityState={{ selected: selected() }}
                onPress={() => props.onToggleRecipient(id())}
                hoverStyle={{ backgroundColor: c().selected }}
                style={{
                  ...row,
                  height: 28,
                  gap: 6,
                  paddingLeft: 6,
                  paddingRight: running() ? 4 : 10,
                  borderWidth: 1,
                  borderColor: selected() ? c().ink : c().border,
                  cursor: "pointer",
                  backgroundColor: selected() ? c().canvas : "transparent",
                }}
              >
                <AgentFace id={id()} size={16} />
                <Label
                  size={12}
                  line={16}
                  lines={1}
                  tone={selected() ? "ink" : "mutedInk"}
                  weight={selected() ? 600 : 400}
                >
                  {running()
                    ? uiText("memberWriting", { name: name() })
                    : name()}
                </Label>
                <If when={running()}>
                  <StatusDot color={c().blue} />
                </If>
                <If when={!props.phone && id() === props.steward}>
                  <Label size={10} line={12} tone="muted">
                    {uiText("steward")}
                  </Label>
                </If>
                <If when={running()}>
                  <If when={props.held && heldOn() === id()}>
                    <View
                      role="button"
                      accessibilityLabel={uiText("queuedMessages", {
                        count: props.held,
                      })}
                      onPress={props.onToggleHeld}
                      style={{ cursor: "pointer" }}
                    >
                      <Label
                        size={11}
                        line={14}
                        tone="mutedInk"
                        style={{ textDecorationLine: "underline" }}
                      >
                        {uiText("queuedMessages", { count: props.held })}
                      </Label>
                    </View>
                  </If>
                  <View
                    role="button"
                    accessibilityLabel={uiText("stopMember", { name: name() })}
                    onPress={() => props.onStop(id())}
                    hoverStyle={{ backgroundColor: c().selected }}
                    style={{
                      ...row,
                      justifyContent: "center",
                      width: 18,
                      height: 18,
                      borderWidth: 1,
                      borderColor: c().strong,
                      backgroundColor: c().canvas,
                      cursor: "pointer",
                    }}
                  >
                    <Icon name="stop" size={10} />
                  </View>
                </If>
              </View>
            );
          }}
        </Each>
      </View>
      <View style={{ ...row, gap: 6 }}>
        <StatusDot color={props.waitsFor ? c().blue : c().green} />
        <Label size={12} line={16} tone={props.waitsFor ? "blue" : "mutedInk"}>
          {props.waitsFor
            ? uiText("waitsUntilFinishes", { names: props.waitsFor })
            : props.names
              ? uiText(
                  props.recipients.length > 1
                    ? "recipientsReply"
                    : "recipientReplies",
                  { names: props.names },
                )
              : uiText("chooseWhoShouldReply")}
        </Label>
      </View>
    </View>
  );
}
