import type { ConversationResults, MessageView } from "@eta/client-contracts";
import type { Outgoing } from "./composer-draft";
import type { Delivery } from "./outbox";
import { effect, keymap, signal, View } from "nsh";
import { colors, Label, row } from "../../components";
import { StatusDot } from "../../components/status-dot";
import { opacity, space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { problemText } from "../../services/problem-text";
import { DeliveryLine } from "./composer-delivery";

/** More names than this read as a list nobody reads: say "them" instead. */
const MAX_NAMES = 3;

/** How wide the tooltip naming who a held message waits for runs before it wraps. */
const tooltipWidth = 520;

type Busy = "pull" | "drop";

/** The agents a held message waits for (`data.woke`), as one phrase. */
function waitingNames(
  message: MessageView,
  nameOf: (agentId: string) => string,
): string {
  const ids = Array.isArray(message.data.woke)
    ? (message.data.woke as string[])
    : [];
  if (ids.length === 0 || ids.length > MAX_NAMES) return uiText("queueThem");
  return ids.map(nameOf).join(uiText("queueSeparator"));
}

const reason = (error: unknown) => problemText(error);

/**
 * Messages that are written but not in the conversation yet, over the member strip and the box
 * that would have sent them: one bordered block each, as wide as the box, the text cut at two lines
 * (the whole of it on hover).
 *
 * They are held because every lane that would answer them was busy: nothing read them, so they are
 * not part of the record and the transcript never shows them. When a lane takes one, the host moves
 * it into the conversation and it leaves this lane. Two things can be done with one, and each waits
 * for the host to say it happened:
 *
 * - pull it back into the box, or drop it (`recall`). A lane that picked it up first makes `recall`
 *   answer false: the words are already in the conversation, and putting them back in the box would
 *   say them twice.
 *
 * With a block focused, E pulls back and Delete drops.
 */
export function HeldMessages(props: {
  messages: MessageView[];
  conversationId: string;
  /** Put the message's text back above whatever is being typed. */
  onPullBack: (text: string) => void;
  phone: boolean;
  /**
   * The reader's messages on their way that will wait here: every agent they go to was answering
   * as they were sent. After the held ones, until the host's rows take their place.
   */
  sending: Delivery[];
  onRetry: (id: string) => void;
  onEdit: (message: Outgoing) => void;
  onDiscard: (id: string) => void;
}) {
  const host = useHost();
  const c = colors();
  const busy = signal<{ id: string; kind: Busy } | undefined>(undefined);
  // What the host said when an action did not do what was asked; it goes by itself.
  const notice = signal("");
  effect(() => {
    if (!notice()) return;
    const timer = setTimeout(() => notice.set(""), 6000);
    return () => clearTimeout(timer);
  });
  const nameOf = (agentId: string) => host.agent(agentId)?.name ?? agentId;
  // A second press before the first answer would only be told the first one took it.
  const inFlight = new Set<string>();

  async function take(message: MessageView, kind: "pull" | "drop") {
    if (inFlight.has(message.id)) return;
    inFlight.add(message.id);
    busy.set({ id: message.id, kind });
    notice.set("");
    try {
      const answer = await host.call<ConversationResults["recall"]>(
        "conversations",
        "recall",
        { conversationId: props.conversationId, messageId: message.id },
      );
      if (!answer.recalled)
        notice.set(
          uiText("queueTaken", { names: waitingNames(message, nameOf) }),
        );
      else if (kind === "pull") props.onPullBack(message.text);
    } catch (error) {
      notice.set(
        uiText(kind === "pull" ? "queuePullFailed" : "queueDropFailed", {
          reason: reason(error),
        }),
      );
    } finally {
      inFlight.delete(message.id);
      busy.set(undefined);
    }
  }

  return (
    <If when={props.messages.length || props.sending.length || notice()}>
      <View
        role="list"
        accessibilityLabel={uiText("queueLane")}
        style={{ gap: space[4] }}
      >
        <If when={notice()}>
          <View role="alert" style={{ ...row, gap: space[4] }}>
            <StatusDot color={c().warning} />
            <Label variant="small" tone="warningInk" style={{ flex: 1 }}>
              {notice()}
            </Label>
          </View>
        </If>
        <Each of={props.messages} key={(message) => message.id}>
          {(message, index) => {
            const id = message().id;
            const focused = signal(false);
            const mine = () =>
              busy()?.id === id
                ? busy()!.kind
                : (undefined as Busy | undefined);
            const names = () => waitingNames(message(), nameOf);
            effect(() => {
              if (!focused()) return;
              return keymap.bind(
                {
                  e: () => void take(message(), "pull"),
                  delete: () => void take(message(), "drop"),
                },
                { when: "always" },
              );
            });
            const head = () => {
              const kind = mine();
              const where =
                index() === 0
                  ? uiText("queueWaitsFor", { names: names() })
                  : uiText("queueAfterPrevious");
              const doing =
                kind === "pull"
                  ? ` · ${uiText("queuePulling")}`
                  : kind === "drop"
                    ? ` · ${uiText("queueDropping")}`
                    : "";
              return `${uiText("queueQueued")} · ${where}${doing}`;
            };
            const action = (label: string, a11y: string, press: () => void) => (
              <View
                role="button"
                accessibilityLabel={a11y}
                accessibilityState={{ disabled: !!mine() }}
                onPress={() => {
                  if (!mine()) press();
                }}
                style={{
                  paddingHorizontal: space[8],
                  paddingVertical: props.phone ? space[8] : space[2],
                  opacity: mine() ? opacity.disabled : 1,
                  cursor: mine() ? undefined : "pointer",
                }}
              >
                <Label variant="small" tone="mutedInk">
                  {label}
                </Label>
              </View>
            );
            return (
              <View
                focusable
                onFocus={() => focused.set(true)}
                onBlur={() => focused.set(false)}
                accessibilityLabel={uiText("queueLabel", {
                  text: message().text,
                })}
                accessibilityState={{ busy: !!mine() }}
                hoverStyle={{ borderColor: c().strong }}
                focusVisibleStyle={{ borderColor: c().blue }}
                style={{
                  borderWidth: 1,
                  borderColor: c().border,
                  backgroundColor: c().canvas,
                }}
              >
                <View
                  style={{
                    ...row,
                    gap: space[4],
                    paddingHorizontal: space[12],
                    paddingTop: space[8],
                  }}
                >
                  <Label
                    variant="caption"
                    tone="muted"
                    lines={1}
                    style={{ flex: 1 }}
                  >
                    {head()}
                  </Label>
                  <If when={props.messages.length > 1 && !mine()}>
                    <Label variant="caption" tone="muted">
                      {`${index() + 1} / ${props.messages.length}`}
                    </Label>
                  </If>
                </View>
                <View
                  tooltip={
                    <View
                      style={{
                        maxWidth: tooltipWidth,
                        paddingHorizontal: space[12],
                        paddingVertical: space[8],
                        backgroundColor: c().ink,
                      }}
                    >
                      <Label variant="small" tone="canvas">
                        {message().text}
                      </Label>
                    </View>
                  }
                  style={{ paddingHorizontal: space[12], paddingTop: space[2] }}
                >
                  <Label lines={2}>{message().text}</Label>
                </View>
                <View
                  style={{
                    ...row,
                    gap: space[2],
                    paddingHorizontal: space[2],
                    paddingTop: space[2],
                    paddingBottom: props.phone ? space[2] : space[8],
                  }}
                >
                  {action(
                    uiText("queuePullBack"),
                    uiText("queuePullBackLabel", { text: message().text }),
                    () => void take(message(), "pull"),
                  )}
                  <View style={{ flex: 1 }} />
                  {action(
                    uiText("queueDrop"),
                    uiText("queueDropLabel", { text: message().text }),
                    () => void take(message(), "drop"),
                  )}
                </View>
              </View>
            );
          }}
        </Each>
        <Each of={props.sending} key={(entry) => entry.message.id}>
          {(entry) => {
            const names = () => {
              const ids = entry().waitsFor;
              return ids.length > MAX_NAMES
                ? uiText("queueThem")
                : ids.map(nameOf).join(uiText("queueSeparator"));
            };
            // Taken by the host: queued as any other, until its row comes.
            const head = () =>
              entry().landed
                ? `${uiText("queueQueued")} · ${uiText("queueWaitsFor", { names: names() })}`
                : `${uiText("sendingQueued")} · ${uiText("sendingWillQueue", { names: names() })}`;
            return (
              <View
                accessibilityLabel={uiText(
                  entry().failure
                    ? "sendFailedLabel"
                    : entry().landed
                      ? "queueLabel"
                      : "sendingQueuedLabel",
                  { text: entry().message.text },
                )}
                style={{
                  borderWidth: 1,
                  borderColor: c().border,
                  backgroundColor: entry().failure ? c().redFill : c().canvas,
                }}
              >
                <View
                  style={{ paddingHorizontal: space[12], paddingTop: space[8] }}
                >
                  <Label variant="caption" tone="muted" lines={1}>
                    {head()}
                  </Label>
                </View>
                <View
                  style={{
                    paddingHorizontal: space[12],
                    paddingTop: space[2],
                    paddingBottom: entry().failure ? space[2] : space[8],
                    opacity:
                      entry().failure || entry().landed ? 1 : opacity.muted,
                  }}
                >
                  <Label lines={2}>
                    {[
                      entry().message.text,
                      ...entry().message.attachments.map((file) => file.name),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Label>
                </View>
                <If when={entry().failure}>
                  <View
                    style={{
                      paddingHorizontal: space[12],
                      paddingBottom: props.phone ? space[2] : space[8],
                    }}
                  >
                    <DeliveryLine
                      failure={entry().failure}
                      phone={props.phone}
                      align="start"
                      onRetry={() => props.onRetry(entry().message.id)}
                      onEdit={() => props.onEdit(entry().message)}
                      onDiscard={() => props.onDiscard(entry().message.id)}
                    />
                  </View>
                </If>
              </View>
            );
          }}
        </Each>
      </View>
    </If>
  );
}
