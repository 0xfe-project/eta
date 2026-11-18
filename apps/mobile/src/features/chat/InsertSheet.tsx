// Insert: words put into the turn a message started, while that turn is still writing. Same rules
// as the web's insert box: the host decides (`conversations.send` with `into`) — while anyone is
// still answering the message, the words join every one of those turns and the row says
// `data.into`; once nobody is, they go out as a message of their own.

import type { MessageView, SendResult } from "@eta/client-contracts";
import type { Chat } from "./conversation";
import { computed, effect, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { t } from "../../i18n";
import { Button } from "../../ui/Button";
import { reason } from "../../ui/format";
import { Sheet } from "../../ui/Sheet";
import { toast } from "../../ui/toast";
import { call } from "../../wire/target";
import { agentName } from "./conversation";
import { rememberRows } from "./rows";

/** What the box grows to before it scrolls inside itself. */
const MAX_TEXT_HEIGHT = 160;

/** An insert not sent yet, by the message it goes into: closing the sheet keeps it. */
const drafts = signal<Record<string, string>>({});
const setDraft = (messageId: string, text: string) =>
  drafts.update((all) => {
    const { [messageId]: _gone, ...rest } = all;
    return text === "" ? rest : { ...all, [messageId]: text };
  });

/** The replies writing an answer to `message` now: what an insert into it reaches. Reactive. */
export function answering(chat: Chat, message: MessageView): MessageView[] {
  return chat
    .messages()
    .filter(
      (row) =>
        row.author === "agent" &&
        row.replyToId === message.id &&
        (row.status === "working" || row.status === "waiting_for_input"),
    );
}

/** The user rows put into `message` (`data.into`), in the order they were sent. Reactive. */
export function insertsInto(chat: Chat, message: MessageView): MessageView[] {
  return chat
    .messages()
    .filter((row) => row.author === "user" && row.data.into === message.id);
}

export function InsertSheet(props: {
  chat: Chat;
  /** The message being inserted into; the sheet is closed without one. */
  message: MessageView | undefined;
  onClose: () => void;
  onSent: () => void;
}) {
  const height = signal(0);
  const sending = signal(false);
  const id = () => props.message?.id ?? "";
  const text = () => drafts()[id()] ?? "";
  /** Who it reaches: the members answering now, or, once they stopped, the ones it was opened for. */
  const reached = signal<string[]>([]);
  const live = computed(() => {
    const message = props.message;
    return message === undefined
      ? []
      : answering(props.chat, message).flatMap((row) =>
          row.agentId === null ? [] : [row.agentId],
        );
  });
  // Kept as the turns end, so the line still names them and a late insert still goes to them.
  effect(() => {
    if (live().length > 0) reached.set(live());
  });
  const targets = () => (live().length > 0 ? live() : reached());
  const names = () =>
    targets()
      .map(agentName)
      .filter((name) => name !== "")
      .join(t("chat.insert.separator"));
  const send = async () => {
    const message = props.message;
    const body = text().trim();
    if (message === undefined || body === "" || sending()) return;
    sending.set(true);
    try {
      const sent = await call<SendResult>("conversations", "send", {
        conversationId: props.chat.id,
        text: body,
        into: message.id,
        mode: "steer",
        mentions: targets(),
        clientId: crypto.randomUUID(),
      });
      // A message held behind a reply is the band's, not the transcript's.
      rememberRows(
        props.chat.id,
        sent.message.data.held === true ? [] : [sent.message, ...sent.replies],
      );
      setDraft(message.id, "");
      if (sent.message.data.into !== message.id) toast(t("chat.insert.ended"));
      props.onSent();
      props.onClose();
    } catch (error) {
      toast(t("common.failed", { message: reason(error) }));
    } finally {
      sending.set(false);
    }
  };
  return (
    <Sheet
      open={props.message !== undefined}
      onClose={props.onClose}
      testID="insert-sheet"
    >
      <View class="gap-1 px-4 pt-4 pb-3">
        <Text class="text-[17px] leading-5 text-foreground">
          {t("chat.insert.title")}
        </Text>
        <Text class="truncate text-sm leading-[18px] text-muted-foreground">
          {t("chat.insert.to", { names: names() })}
        </Text>
      </View>
      <Input
        testID="insert-input"
        accessibilityLabel={t("chat.insert.input")}
        multiline
        autoFocus
        value={text()}
        placeholder={t("chat.insert.input")}
        onChange={({ value }) => setDraft(id(), value)}
        onContentSizeChange={({ size }) =>
          height.set(Math.min(size.height, MAX_TEXT_HEIGHT))
        }
        class="mx-4 border border-border-strong px-3 py-[10px] text-input leading-5 text-foreground placeholder:text-faint"
        style={{ height: Math.max(Math.max(height(), 20) + 20, 64) }}
      />
      <View class="flex-row gap-2 px-4 pt-3 pb-2">
        <Button
          title={t("common.cancel")}
          height={44}
          onPress={props.onClose}
        />
        <Button
          title={t("chat.insert.send")}
          testID="insert-send"
          height={44}
          variant="primary"
          disabled={text().trim() === "" || sending()}
          onPress={() => void send()}
        />
      </View>
    </Sheet>
  );
}
