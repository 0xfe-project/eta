import type { ConversationResults, MessageView } from "@eta/client-contracts";
import { effect, signal, View } from "nsh";
import { Button, Field, Label, row } from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

export function indexInserts(messages: MessageView[]) {
  const prompts = new Set(
    messages.filter((m) => m.author === "user").map((m) => m.id),
  );
  const additions = new Map<string, MessageView[]>();
  const recipients = new Map<string, string[]>();
  const rows = messages.filter((message) => {
    const { into } = message.data;
    if (
      message.author === "user" &&
      typeof into === "string" &&
      prompts.has(into) &&
      into !== message.id
    ) {
      const list = additions.get(into) ?? [];
      list.push(message);
      additions.set(into, list);
      return false;
    }
    if (
      message.agentId &&
      message.replyToId &&
      (message.status === "working" || message.status === "waiting_for_input")
    ) {
      const ids = recipients.get(message.replyToId) ?? [];
      if (!ids.includes(message.agentId)) ids.push(message.agentId);
      recipients.set(message.replyToId, ids);
    }
    return true;
  });
  return { rows, additions, recipients };
}

interface Draft {
  text: string;
  clientId: string;
}
const drafts = new Map<string, Draft>();

/**
 * The words to add to a turn that is still running, in the popover under the
 * user message it answers: a 72-high field, who it goes to and the Insert
 * button.
 */
export function InsertMessage(props: {
  message: MessageView;
  recipients: () => string[];
  initialRecipients: string[];
  phone: boolean;
  onClose: () => void;
  onLate: () => void;
}) {
  const host = useHost();
  const key = JSON.stringify([
    host.address()?.origin,
    props.message.conversationId,
    props.message.id,
  ]);
  const draft = signal(drafts.get(key)?.text ?? "");
  const sending = signal(false);
  const error = signal("");
  const targets = signal(props.initialRecipients);
  effect(() => {
    const live = props.recipients();
    if (live.length) targets.set(live);
  });
  function edit(text: string) {
    if (text === draft()) return;
    if (text) drafts.set(key, { text, clientId: crypto.randomUUID() });
    else drafts.delete(key);
    error.set("");
    draft.set(text);
  }
  async function send() {
    const pending = drafts.get(key);
    if (!pending?.text.trim() || sending() || host.state().status !== "open")
      return;
    sending.set(true);
    error.set("");
    try {
      const result = await host.call<ConversationResults["send"]>(
        "conversations",
        "send",
        {
          conversationId: props.message.conversationId,
          text: pending.text.trim(),
          into: props.message.id,
          mentions: targets(),
          mode: "steer",
          clientId: pending.clientId,
        },
      );
      if (drafts.get(key) === pending) drafts.delete(key);
      if (result.message.data.into !== props.message.id) props.onLate();
      props.onClose();
    } catch (cause) {
      error.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      sending.set(false);
    }
  }
  const names = () =>
    targets()
      .map((id) => host.agent(id)?.name ?? id)
      .join(", ");
  const ready = () =>
    Boolean(draft().trim()) && !sending() && host.state().status === "open";
  return (
    <View style={{ width: 288 }}>
      <View style={{ padding: 8 }}>
        <Field
          label={uiText("insertMessage")}
          placeholder={uiText("addToThisTurn")}
          multiline
          value={draft()}
          inputRef={(node) => queueMicrotask(() => node.focus())}
          onChange={edit}
          onSubmit={props.phone ? undefined : () => void send()}
          style={{ height: 72, paddingVertical: 6 }}
        />
      </View>
      <If when={error()}>
        <Label
          variant="caption"
          tone="red"
          style={{ paddingHorizontal: 8, paddingBottom: 8 }}
        >
          {error()}
        </Label>
      </If>
      <View
        style={{
          ...row,
          justifyContent: "space-between",
          gap: 8,
          paddingHorizontal: 8,
          paddingBottom: 8,
        }}
      >
        <Label variant="caption" tone="faint" lines={1} style={{ flex: 1 }}>
          {props.phone
            ? uiText("to", { join: names() })
            : uiText("insertHint", { names: names() })}
        </Label>
        <Button
          label={uiText("insert")}
          size={22}
          labelTone={ready() ? "ink" : "faint"}
          dimDisabled={false}
          disabled={!ready()}
          onPress={() => void send()}
        />
      </View>
    </View>
  );
}
