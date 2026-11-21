import type { ConversationResults, MemberView } from "@eta/client-contracts";
import { Scroll, signal, View } from "nsh";
import { Button, colors, Icon, Label, row } from "../../components";
import { AgentFace } from "../../components/agent-face";
import { StatusDot } from "../../components/status-dot";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

function StopMemberReply(props: {
  conversationId: string;
  messageId: string;
  name: string;
}) {
  const host = useHost();
  const c = colors();
  const pending = signal(false);
  // This component is keyed by the reply. A late press belongs to that same row.
  const target = {
    conversationId: props.conversationId,
    messageId: props.messageId,
  };
  async function stop() {
    if (pending()) return;
    pending.set(true);
    const result = await host.action(() =>
      host.call<ConversationResults["stop"]>("conversations", "stop", target),
    );
    if (result === undefined) pending.set(false);
  }
  return (
    <View
      role="button"
      accessibilityLabel={uiText("stopMember", { name: props.name })}
      accessibilityState={{ disabled: pending() }}
      onPress={() => void stop()}
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
  );
}

export function ComposerRecipients(props: {
  phone: boolean;
  tablet: boolean;
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
  conversationId: string;
}) {
  const c = colors();
  const host = useHost();
  const expanded = signal(false);
  const collapsed = () =>
    props.tablet && props.members.length > 3 && !expanded();
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
        alignItems: props.phone ? "stretch" : "center",
        justifyContent: "space-between",
        gap: 6,
      }}
    >
      <Scroll
        horizontal
        style={{ minWidth: 0, flex: props.phone ? undefined : 1, height: 28 }}
      >
        <View style={{ ...row, gap: 6 }}>
          <View
            role="button"
            accessibilityLabel={uiText("everyone")}
            accessibilityState={{ selected: everyone() }}
            onPress={() =>
              props.onChangeMentions(
                everyone()
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
              flexShrink: 0,
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
            <Label variant="small" tone="mutedInk">
              {uiText("everyone")}
            </Label>
          </View>
          <Each
            of={collapsed() ? props.members.slice(0, 3) : props.members}
            key={(member) => member.agentId}
          >
            {(member) => {
              const id = () => member().agentId;
              const selected = () => props.recipients.includes(id());
              const running = () => props.running.includes(id());
              const name = () => host.agent(id())?.name ?? uiText("agent");
              return (
                <View
                  style={{
                    ...row,
                    height: 28,
                    gap: 6,
                    paddingLeft: 6,
                    paddingRight: running() ? 4 : props.phone ? 8 : 10,
                    flexShrink: 0,
                    borderWidth: 1,
                    borderColor: selected() ? c().ink : c().border,
                    cursor: "pointer",
                    backgroundColor: selected() ? c().canvas : "transparent",
                  }}
                >
                  <View
                    role="button"
                    accessibilityLabel={name()}
                    accessibilityState={{ selected: selected() }}
                    onPress={() => props.onToggleRecipient(id())}
                    hoverStyle={{ backgroundColor: c().selected }}
                    style={{
                      ...row,
                      gap: 6,
                      alignSelf: "stretch",
                      cursor: "pointer",
                    }}
                  >
                    <AgentFace id={id()} size={16} />
                    <Label
                      variant="small"
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
                      <Label variant="caption" tone="muted">
                        {uiText("steward")}
                      </Label>
                    </If>
                  </View>
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
                          variant="caption"
                          tone="mutedInk"
                          style={{ textDecorationLine: "underline" }}
                        >
                          {uiText("queuedMessages", { count: props.held })}
                        </Label>
                      </View>
                    </If>
                    <Each
                      of={
                        member().activeReplyId ? [member().activeReplyId!] : []
                      }
                    >
                      {(replyId) => (
                        <StopMemberReply
                          conversationId={props.conversationId}
                          messageId={replyId()}
                          name={name()}
                        />
                      )}
                    </Each>
                  </If>
                </View>
              );
            }}
          </Each>
          <If when={collapsed()}>
            <Button
              label={`+${props.members.length - 3}`}
              size={28}
              onPress={() => expanded.set(true)}
            />
          </If>
        </View>
      </Scroll>
      <View style={{ ...row, gap: 6 }}>
        <StatusDot color={props.waitsFor ? c().blue : c().green} />
        <Label variant="small" tone={props.waitsFor ? "blue" : "mutedInk"}>
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
