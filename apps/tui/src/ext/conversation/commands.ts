/** `/open`, `/queue`, `/steer` and `/stop`: the conversation commands. */
import type { ShellContext, SlashCommand } from "../../extensions/types";
import { commandUsage } from "../../extensions/usage";
import { translatorFor } from "../../i18n/messages";
import { conversationList, namedMembers } from "./facts";
import { feedFor } from "./feed/store";
import { CONVERSATION_VIEW } from "./kind";
import { conversationMessages } from "./messages";
import { mentionedMembers } from "./model/mentions";
import { matchConversation } from "./open-match";
import { sendMessage, stopReplies } from "./send";

const texts = (ctx: ShellContext) =>
  translatorFor(conversationMessages, ctx.locale);

/** Says how to type `command` in the status area. */
function usageError(ctx: ShellContext, command: SlashCommand): void {
  ctx.notify(texts(ctx)("usage", { usage: commandUsage(command) }), "error");
}

/** The conversation in front, or undefined after saying a conversation has to be opened. */
function frontConversation(ctx: ShellContext): string | undefined {
  const tab = ctx.activeTab;
  if (tab?.kind === CONVERSATION_VIEW) return tab.id;
  ctx.notify(texts(ctx)("openFirst"), "error");
  return undefined;
}

const open: SlashCommand = {
  name: "open",
  args: [
    {
      name: "conversation",
      required: true,
      summary: {
        en: "Its id, its name, or enough of its name to tell it apart",
        zh: "对话的 id、名字，或足以区分它的一段名字",
      },
    },
  ],
  summary: {
    en: "Open a conversation in a tab",
    zh: "在标签页里打开一个对话",
  },
  examples: [
    {
      input: "/open release",
      summary: {
        en: "Open the conversation whose name starts with or holds “release”",
        zh: "打开名字以“release”开头或包含它的对话",
      },
    },
  ],
  requiredOps: [],
  run: (ctx, argText) => {
    if (argText === "") {
      usageError(ctx, open);
      return;
    }
    const t = texts(ctx);
    const match = matchConversation(
      conversationList(ctx.wire.store.getState()),
      argText,
    );
    switch (match.kind) {
      case "found":
        ctx.openTab({ kind: CONVERSATION_VIEW, id: match.conversation.id });
        return;
      case "ambiguous":
        ctx.notify(
          t("severalConversations", {
            name: argText,
            names: match.names.join(t("nameSeparator")),
          }),
          "warning",
        );
        return;
      case "none":
        ctx.notify(t("noSuchConversation", { name: argText }), "error");
    }
  },
};

/** A command that sends its argument to the conversation in front, joining a reply as `mode` says. */
function sendCommand(
  mode: "queue" | "steer",
  described: Pick<SlashCommand, "name" | "summary" | "examples">,
): SlashCommand {
  const command: SlashCommand = {
    ...described,
    args: [
      {
        name: "message",
        required: true,
        summary: { en: "What to say", zh: "要说的话" },
      },
    ],
    requiredOps: ["conversations.send"],
    run: async (ctx, argText) => {
      if (argText === "") {
        usageError(ctx, command);
        return;
      }
      const id = frontConversation(ctx);
      if (id === undefined) return;
      const members = namedMembers(feedFor(ctx.wire, id).store.getState());
      await sendMessage(ctx, id, {
        text: argText,
        pastes: [],
        mentions: mentionedMembers(argText, members),
        mode,
      });
    },
  };
  return command;
}

const queue = sendCommand("queue", {
  name: "queue",
  summary: {
    en: "Send a message to the conversation in front, after the reply that is running",
    zh: "给最前面的对话发消息，排在正在跑的回复之后",
  },
  examples: [
    {
      input: "/queue then write the tests",
      summary: {
        en: "Ask for the tests once the current reply ends",
        zh: "等当前回复结束后再要测试",
      },
    },
  ],
});

const steer = sendCommand("steer", {
  name: "steer",
  summary: {
    en: "Send a message into the reply running in the conversation in front",
    zh: "把消息插进最前面对话正在跑的回复",
  },
  examples: [
    {
      input: "/steer use the new API instead",
      summary: {
        en: "Change course while the reply is still running",
        zh: "回复还在跑的时候改方向",
      },
    },
  ],
});

const stop: SlashCommand = {
  name: "stop",
  args: [],
  summary: {
    en: "Stop every reply running in the conversation in front",
    zh: "停止最前面对话里所有在跑的回复",
  },
  examples: [
    {
      input: "/stop",
      summary: { en: "Stop the replies", zh: "停止回复" },
    },
  ],
  requiredOps: ["conversations.stop"],
  run: async (ctx) => {
    const id = frontConversation(ctx);
    if (id === undefined) return;
    await stopReplies(ctx.wire, id);
  },
};

export const conversationCommands: SlashCommand[] = [open, queue, steer, stop];
