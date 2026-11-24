import type { ConversationResults, MessageView } from "@eta/client-contracts";
import { effect, signal, View } from "nsh";
import { Button, colors, Label, row } from "../../components";
import {
  chatText,
  draft,
  limit,
  openDocDraft,
  serialize,
  submitKeys,
} from "../../components/eta-editor";
import { control, space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

export function indexInserts(messages: MessageView[]) {
  const prompts = new Set(
    messages.filter((m) => m.author === "user").map((m) => m.id),
  );
  const additions = new Map<string, MessageView[]>();
  const recipients = new Map<string, string[]>();
  const rows = messages.filter((message) => {
    // Written for the agent that drafted the task to read: not shown.
    if (message.data.event === "task_draft_decided") return false;
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

/**
 * The words to add to a turn that is still running, in the popover under the
 * user message it answers: the chat's text (`chatText`: formatted, long pastes
 * folded; no `@` and no files, a steer carries text to the agents already
 * replying), who it goes to and the Insert button. Its draft is kept per
 * message, so closing the popover loses nothing.
 */
/** The insert popover: its width, the room it keeps while its draft loads, its editor's bounds. */
const popoverWidth = 288;
const placeholderHeight = 120;
const editorHeight = { min: 72, max: 200 } as const;

export function InsertMessage(props: {
  message: MessageView;
  recipients: () => string[];
  initialRecipients: string[];
  phone: boolean;
  onClose: () => void;
  onLate: () => void;
}) {
  const host = useHost();
  const store = openDocDraft(
    `eta.insert.v1.${JSON.stringify([
      host.address()?.origin,
      props.message.conversationId,
      props.message.id,
    ])}`,
  );
  return (
    <If
      when={store.ready()}
      else={<View style={{ width: popoverWidth, height: placeholderHeight }} />}
    >
      {() => <InsertBody {...props} store={store} />}
    </If>
  );
}

function InsertBody(props: {
  message: MessageView;
  recipients: () => string[];
  initialRecipients: string[];
  phone: boolean;
  onClose: () => void;
  onLate: () => void;
  store: ReturnType<typeof openDocDraft>;
}) {
  const host = useHost();
  const c = colors();
  const sending = signal(false);
  const error = signal("");
  const targets = signal(props.initialRecipients);
  effect(() => {
    const live = props.recipients();
    if (live.length) targets.set(live);
  });
  const limits = limit();
  const out = serialize();
  /** One id per wording, so a retry of the same words is the same message. */
  let attempt: { text: string; id: string } | undefined;
  const editor = chatText.createEditor({
    doc: props.store.doc(),
    plugins: [
      submitKeys({ onSubmit: () => void send() }),
      draft({ save: props.store.save }),
      limits,
      out,
    ],
  });
  editor.onChange(() => error.set(""));
  async function send() {
    if (
      out.state().blank ||
      limits.tooLong() ||
      sending() ||
      host.state().status !== "open"
    )
      return;
    const sent = out.read();
    if (attempt?.text !== sent.text)
      attempt = { text: sent.text, id: crypto.randomUUID() };
    sending.set(true);
    error.set("");
    try {
      const result = await host.call<ConversationResults["send"]>(
        "conversations",
        "send",
        {
          conversationId: props.message.conversationId,
          text: sent.text,
          blocks: sent.blocks.length ? sent.blocks : undefined,
          into: props.message.id,
          mentions: targets(),
          mode: "steer",
          clientId: attempt.id,
        },
      );
      editor.clear();
      attempt = undefined;
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
  const canSend = () =>
    !out.state().blank && !limits.tooLong() && host.state().status === "open";
  return (
    <View style={{ width: popoverWidth }}>
      <View style={{ padding: space[8], gap: space[4] }}>
        <If when={limits.tooLong()}>
          <Label variant="caption" tone="warning">
            {uiText("composerTooLong")}
          </Label>
        </If>
        <chatText.Editor
          editor={editor}
          label={uiText("insertMessage")}
          placeholder={uiText("addToThisTurn")}
          autoFocus
          variant="small"
          minHeight={editorHeight.min}
          maxHeight={editorHeight.max}
          padding={{
            top: space[8],
            bottom: space[8],
            left: space[8],
            right: space[8],
          }}
          style={{ borderWidth: 1, borderColor: c().border }}
        />
      </View>
      <If when={error()}>
        <Label
          variant="caption"
          tone="red"
          style={{ paddingHorizontal: space[8], paddingBottom: space[8] }}
        >
          {error()}
        </Label>
      </If>
      <View
        style={{
          ...row,
          justifyContent: "space-between",
          gap: space[8],
          paddingHorizontal: space[8],
          paddingBottom: space[8],
        }}
      >
        <Label variant="caption" tone="faint" lines={1} style={{ flex: 1 }}>
          {props.phone
            ? uiText("to", { join: names() })
            : uiText("insertHint", { names: names() })}
        </Label>
        <Button
          label={uiText("insert")}
          size={control.sm}
          labelTone={canSend() ? "ink" : "faint"}
          dimDisabled={false}
          disabled={!canSend()}
          busy={sending()}
          onPress={() => void send()}
        />
      </View>
    </View>
  );
}
