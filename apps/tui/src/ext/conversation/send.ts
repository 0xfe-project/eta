/** What the view and the commands ask of the host about a conversation. */
import type { SendResult } from "@eta/client-contracts";
import type { WireClient } from "../../connection/types";
import type { ShellContext } from "../../extensions/types";
import type { PasteRange } from "./contract";
import { translatorFor } from "../../i18n/messages";
import { conversationMessages } from "./messages";

export interface OutgoingMessage {
  text: string;
  /** Where folded pastes sit in `text`; sent as `blocks` when there are any. */
  pastes: readonly PasteRange[];
  /** Agent ids. */
  mentions: readonly string[];
  mode: "queue" | "steer";
}

/**
 * Sends a message to the conversation, as a new message each time. When nobody took it (no
 * steward, nobody named), says so in the status area. Rejects with the host's error.
 */
export async function sendMessage(
  ctx: Pick<ShellContext, "wire" | "notify" | "locale">,
  conversationId: string,
  message: OutgoingMessage,
): Promise<void> {
  const result = await ctx.wire.call<SendResult>("conversations", "send", {
    conversationId,
    text: message.text,
    mentions: message.mentions,
    mode: message.mode,
    ...(message.pastes.length > 0 ? { blocks: message.pastes } : {}),
    clientId: crypto.randomUUID(),
  });
  if (result.nobody)
    ctx.notify(
      translatorFor(conversationMessages, ctx.locale)("nobody"),
      "warning",
    );
}

/** Stops every reply running in the conversation. Rejects with the host's error. */
export async function stopReplies(
  wire: WireClient,
  conversationId: string,
): Promise<void> {
  await wire.call("conversations", "stop", { conversationId });
}

/** The last `seq` each conversation's read mark was asked to move to, per wire. */
const readAsked = new WeakMap<WireClient, Map<string, number>>();

/**
 * Moves the user's read mark to `seq`, asking the host once per `seq` and conversation. Asks
 * nothing of a host without `conversations.read`; a failure is dropped, the mark only stays.
 */
export function markRead(
  wire: WireClient,
  conversationId: string,
  seq: number,
): void {
  if (!wire.can("conversations.read")) return;
  let asked = readAsked.get(wire);
  if (asked === undefined) {
    asked = new Map();
    readAsked.set(wire, asked);
  }
  if (asked.get(conversationId) === seq) return;
  asked.set(conversationId, seq);
  wire.call("conversations", "read", { conversationId, seq }).catch(() => {});
}
