import type { ConversationResults, MemberView } from "@eta/client-contracts";
import { Scroll, signal, View } from "nsh";
import { Button, colors, Icon, Label, row } from "../../components";
import { AgentFace } from "../../components/agent-face";
import { shownWhile } from "../../components/pending";
import { Spinner } from "../../components/spinner";
import { StatusDot } from "../../components/status-dot";
import { avatar, control, icon, space, weight } from "../../components/tokens";
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
  const waiting = shownWhile(pending);
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
      accessibilityState={{ disabled: pending(), busy: pending() }}
      onPress={() => void stop()}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        ...row,
        justifyContent: "center",
        width: control.sm,
        height: control.sm,
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
        cursor: "pointer",
      }}
    >
      <If when={waiting()} else={<Icon name="stop" size={icon.sm} />}>
        <Spinner size={icon.sm} />
      </If>
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
  names: string;
  /** The recipients a new message would wait for, by name. */
  waitsFor: string;
  onChangeMentions: (mentions: string[] | null) => void;
  onToggleRecipient: (agentId: string) => void;
  conversationId: string;
}) {
  const c = colors();
  const host = useHost();
  const expanded = signal(false);
  const collapsed = () =>
    props.tablet && props.members.length > 3 && !expanded();
  // With no scrollbar, a right-edge fade says the row goes on: it shows
  // while chips are hidden past the right edge.
  const viewport = signal(0);
  const content = signal(0);
  const offset = signal(0);
  const more = () => content() - offset() - viewport() > 1;
  const everyone = () => props.mentions?.length === props.members.length;
  return (
    <View
      style={{
        flexDirection: props.phone ? "column-reverse" : "row",
        alignItems: props.phone ? "stretch" : "center",
        justifyContent: "space-between",
        gap: space[4],
      }}
    >
      <View
        style={{
          minWidth: 0,
          flex: props.phone ? undefined : 1,
          height: control.md,
        }}
      >
        <Scroll
          horizontal
          scrollbar={false}
          style={{ flex: 1 }}
          scrollEventThrottle={16}
          onLayout={(event) => viewport.set(event.bounds.size.width)}
          onScroll={(event) => offset.set(event.offset.x)}
        >
          <View
            style={{ ...row, gap: space[4] }}
            onLayout={(event) => content.set(event.bounds.size.width)}
          >
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
                height: control.md,
                gap: space[4],
                paddingLeft: space[8],
                paddingRight: space[12],
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
                  width: icon.md,
                  height: icon.md,
                  borderWidth: 1,
                  borderColor: c().strong,
                  backgroundColor: c().canvas,
                }}
              >
                <If when={everyone()}>
                  <Icon name="check" size={icon.sm} />
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
                // The chip keeps only its border; the button fills it, padding inside, so its
                // hover reaches the border. A running reply's stop button sits beside the
                // button, past its right padding (the old gap), with its own hover.
                return (
                  <View
                    style={{
                      ...row,
                      height: control.md,
                      paddingRight: running() ? space[4] : 0,
                      flexShrink: 0,
                      borderWidth: 1,
                      borderColor: selected() ? c().ink : c().border,
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
                        gap: space[4],
                        alignSelf: "stretch",
                        paddingLeft: space[8],
                        paddingRight: running()
                          ? space[8]
                          : props.phone
                            ? space[8]
                            : space[12],
                        cursor: "pointer",
                      }}
                    >
                      <AgentFace id={id()} size={avatar.sm} />
                      <Label
                        variant="small"
                        lines={1}
                        tone={selected() ? "ink" : "mutedInk"}
                        weight={selected() ? weight.strong : weight.regular}
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
                      <Each
                        of={
                          member().activeReplyId
                            ? [member().activeReplyId!]
                            : []
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
                size={control.md}
                onPress={() => expanded.set(true)}
              />
            </If>
          </View>
        </Scroll>
        <If when={more()}>
          <View
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              bottom: 0,
              width: space[32],
              pointerEvents: "none",
              backgroundImage: `linear-gradient(90deg, ${c().canvas}00 0%, ${c().canvas} 100%)`,
            }}
          />
        </If>
      </View>
      <View style={{ ...row, gap: space[4] }}>
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
