/**
 * `/rename`, `/archive`, `/unarchive`, `/invite`, `/remove`, `/steward` and `/new`: managing
 * conversations from the command line.
 */
import type { ConversationSummary } from "@eta/client-contracts";
import type { ShellContext, SlashCommand } from "../../extensions/types";
import type { StewardChoice } from "./actions";
import type { NamedAgent } from "./facts";
import { createElement } from "react";
import { hostHas } from "../../extensions/host-ops";
import { commandUsage } from "../../extensions/usage";
import { translatorFor } from "../../i18n/messages";
import { conversationList } from "../conversation/facts";
import { CONVERSATION_VIEW } from "../conversation/kind";
import { matchByName, matchConversation } from "../conversation/open-match";
import { invite, remove, rename, setArchived, setSteward } from "./actions";
import { membersOf, outsidersOf, summaryOf } from "./facts";

import { manageMessages } from "./messages";
import { NEW_CONVERSATION_OPS, openNewConversation } from "./new/open";
import { PickLayer } from "./pick-layer";
import { StewardLayer } from "./steward-layer";

const texts = (ctx: ShellContext) => translatorFor(manageMessages, ctx.locale);

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

/**
 * The conversation among `list` that `query` means, or undefined after saying it could be
 * several or none.
 */
function namedConversation(
  ctx: ShellContext,
  list: readonly ConversationSummary[],
  query: string,
): ConversationSummary | undefined {
  const t = texts(ctx);
  const match = matchConversation(list, query);
  if (match.kind === "found") return match.conversation;
  if (match.kind === "ambiguous")
    ctx.notify(
      t("severalConversations", {
        name: query,
        names: match.names.join(t("nameSeparator")),
      }),
      "warning",
    );
  else ctx.notify(t("noSuchConversation", { name: query }), "error");
  return undefined;
}

/** The agent among `agents` that `query` means, or undefined after saying it could be several or none. */
function namedAgent(
  ctx: ShellContext,
  agents: readonly NamedAgent[],
  query: string,
): NamedAgent | undefined {
  const t = texts(ctx);
  const match = matchByName(agents, query);
  if (match.kind === "found") return match.item;
  if (match.kind === "ambiguous")
    ctx.notify(
      t("severalAgents", {
        name: query,
        names: match.names.join(t("nameSeparator")),
      }),
      "warning",
    );
  else ctx.notify(t("noSuchAgent", { name: query }), "error");
  return undefined;
}

const conversationArg = (required: boolean) => ({
  name: "conversation",
  required,
  summary: {
    en: "Its id, its name, or enough of its name to tell it apart",
    zh: "对话的 id、名字，或足以区分它的一段名字",
  },
});

const renameCommand: SlashCommand = {
  name: "rename",
  args: [
    {
      name: "name",
      required: true,
      summary: { en: "The new name", zh: "新名字" },
    },
  ],
  summary: {
    en: "Rename the conversation in front",
    zh: "给最前面的对话改名",
  },
  examples: [
    {
      input: "/rename Launch plan",
      summary: {
        en: "Call the conversation “Launch plan”",
        zh: "把对话改名为“Launch plan”",
      },
    },
  ],
  requiredOps: ["conversations.update"],
  run: async (ctx, argText) => {
    const name = argText.trim();
    if (name === "") {
      usageError(ctx, renameCommand);
      return;
    }
    const id = frontConversation(ctx);
    if (id === undefined) return;
    await rename(ctx, id, name);
  },
};

const archiveCommand: SlashCommand = {
  name: "archive",
  args: [conversationArg(false)],
  summary: {
    en: "Archive a conversation, the one in front unless named, and close its tab",
    zh: "归档一个对话（不写就是最前面的），并关掉它的标签",
  },
  examples: [
    {
      input: "/archive",
      summary: {
        en: "Archive the conversation in front",
        zh: "归档最前面的对话",
      },
    },
    {
      input: "/archive release",
      summary: {
        en: "Archive the conversation whose name starts with or holds “release”",
        zh: "归档名字以“release”开头或包含它的对话",
      },
    },
  ],
  requiredOps: ["conversations.update"],
  run: async (ctx, argText) => {
    const id =
      argText === ""
        ? frontConversation(ctx)
        : namedConversation(
            ctx,
            conversationList(ctx.wire.store.getState()).filter(
              (c) => !c.archived,
            ),
            argText,
          )?.id;
    if (id === undefined) return;
    await setArchived(ctx, id, true);
    ctx.closeTab({ kind: CONVERSATION_VIEW, id });
  },
};

const unarchiveCommand: SlashCommand = {
  name: "unarchive",
  args: [conversationArg(true)],
  summary: {
    en: "Bring an archived conversation back and open it",
    zh: "取消归档一个对话并打开它",
  },
  examples: [
    {
      input: "/unarchive release",
      summary: {
        en: "Bring back the archived conversation named like “release”",
        zh: "取消归档名字像“release”的对话",
      },
    },
  ],
  requiredOps: ["conversations.update"],
  run: async (ctx, argText) => {
    if (argText === "") {
      usageError(ctx, unarchiveCommand);
      return;
    }
    const found = namedConversation(
      ctx,
      conversationList(ctx.wire.store.getState()).filter((c) => c.archived),
      argText,
    );
    if (found === undefined) return;
    await setArchived(ctx, found.id, false);
    ctx.openTab({ kind: CONVERSATION_VIEW, id: found.id });
  },
};

const agentArg = {
  name: "agent",
  required: false,
  summary: {
    en: "The agent's name, or enough of it to tell it apart",
    zh: "智能体的名字，或足以区分它的一段名字",
  },
};

/**
 * The conversation in front for a command that changes who is in it: undefined after saying a
 * conversation has to be opened, that its details (its kind and members) have not arrived, or that
 * a private chat takes nobody else.
 */
function groupInFront(
  ctx: ShellContext,
): { id: string; summary: ConversationSummary } | undefined {
  const id = frontConversation(ctx);
  if (id === undefined) return undefined;
  const summary = summaryOf(ctx.wire.store.getState(), id);
  if (summary === undefined) {
    ctx.notify(texts(ctx)("notArrived"), "error");
    return undefined;
  }
  if (summary.kind === "direct") {
    ctx.notify(texts(ctx)("privateChat"), "error");
    return undefined;
  }
  return { id, summary };
}

/** `/invite` and `/remove`: one command over the agents outside the conversation, or its members. */
function membershipCommand(
  described: Pick<SlashCommand, "name" | "summary" | "examples">,
  op: "invite" | "remove",
): SlashCommand {
  const act = op === "invite" ? invite : remove;
  const requiredOp = `conversations.${op}`;
  return {
    ...described,
    args: [agentArg],
    requiredOps: [requiredOp],
    run: async (ctx, argText) => {
      const front = groupInFront(ctx);
      if (front === undefined) return;
      const state = ctx.wire.store.getState();
      const candidates =
        op === "invite"
          ? outsidersOf(state, front.summary)
          : membersOf(state, front.summary);
      if (argText !== "") {
        const agent = namedAgent(ctx, candidates, argText);
        if (agent !== undefined) await act(ctx, front.id, agent);
        return;
      }
      const t = texts(ctx);
      const conversation = front.summary.name;
      if (candidates.length === 0) {
        ctx.notify(
          t(op === "invite" ? "nobodyToInvite" : "nobodyToRemove", {
            conversation,
          }),
          "info",
        );
        return;
      }
      ctx.openLayer((handle) =>
        createElement(PickLayer, {
          title: t(op === "invite" ? "inviteTitle" : "removeTitle", {
            conversation,
          }),
          rows: candidates.map((agent) => ({
            key: agent.id,
            label: agent.name,
          })),
          onChoose: (index) => {
            if (!hostHas(ctx, requiredOp, described.name)) return;
            ctx.reportFailure(act(ctx, front.id, candidates[index]!));
          },
          handle,
        }),
      );
    },
  };
}

const inviteCommand = membershipCommand(
  {
    name: "invite",
    summary: {
      en: "Invite an agent into the conversation in front",
      zh: "邀请一个智能体加入最前面的对话",
    },
    examples: [
      {
        input: "/invite",
        summary: { en: "Choose whom to invite", zh: "选要邀请谁" },
      },
      {
        input: "/invite cleo",
        summary: { en: "Invite Cleo", zh: "邀请 Cleo" },
      },
    ],
  },
  "invite",
);

const removeCommand = membershipCommand(
  {
    name: "remove",
    summary: {
      en: "Take a member out of the conversation in front",
      zh: "把一个成员移出最前面的对话",
    },
    examples: [
      {
        input: "/remove",
        summary: { en: "Choose whom to take out", zh: "选要移出谁" },
      },
      {
        input: "/remove ben",
        summary: { en: "Take Ben out", zh: "把 Ben 移出" },
      },
    ],
  },
  "remove",
);

/** What `/steward` takes besides a member's name. */
const FOLLOW_PROJECT = "project";
const NO_STEWARD = "none";

const stewardCommand: SlashCommand = {
  name: "steward",
  args: [
    {
      name: "agent",
      required: false,
      summary: {
        en: "A member's name, “project” to follow the project's steward, or “none”",
        zh: "成员的名字；“project” 表示跟随项目的主理人；“none” 表示不要主理人",
      },
    },
  ],
  summary: {
    en: "Choose who takes the messages of the conversation in front that name nobody",
    zh: "选最前面对话的主理人：没点名的消息交给谁",
  },
  examples: [
    {
      input: "/steward",
      summary: { en: "Choose from a list", zh: "从列表里选" },
    },
    {
      input: "/steward ada",
      summary: { en: "Make Ada the steward", zh: "让 Ada 当主理人" },
    },
    {
      input: "/steward project",
      summary: {
        en: "Follow the project's steward",
        zh: "跟随项目的主理人",
      },
    },
    {
      input: "/steward none",
      summary: { en: "Have no steward", zh: "不要主理人" },
    },
  ],
  requiredOps: ["conversations.setSteward"],
  run: async (ctx, argText) => {
    const id = frontConversation(ctx);
    if (id === undefined) return;
    const state = ctx.wire.store.getState();
    const summary = summaryOf(state, id);
    const members = membersOf(state, summary);
    if (argText !== "") {
      let choice: StewardChoice | undefined;
      if (argText === FOLLOW_PROJECT) choice = { kind: "project" };
      else if (argText === NO_STEWARD) choice = { kind: "none" };
      else {
        const agent = namedAgent(ctx, members, argText);
        choice = agent === undefined ? undefined : { kind: "agent", agent };
      }
      if (choice !== undefined) await setSteward(ctx, id, choice);
      return;
    }
    ctx.openLayer((handle) =>
      createElement(StewardLayer, {
        conversationId: id,
        conversationName: summary?.name ?? id,
        members,
        onChoose: (choice) => {
          if (!hostHas(ctx, "conversations.setSteward", stewardCommand.name))
            return;
          ctx.reportFailure(setSteward(ctx, id, choice));
        },
        handle,
      }),
    );
  },
};

const newCommand: SlashCommand = {
  name: "new",
  args: [
    {
      name: "path",
      required: false,
      summary: {
        en: "The absolute path of a directory on the host's machine to start the conversation in",
        zh: "在 host 所在机器上的这个目录里新建对话，写绝对路径",
      },
    },
  ],
  summary: {
    en: "Start a new conversation: where, then who",
    zh: "新建对话：先选在哪里，再选谁",
  },
  examples: [
    {
      input: "/new",
      summary: {
        en: "Choose a project, type a path or browse to a directory",
        zh: "选一个项目，输入路径，或浏览到一个目录",
      },
    },
    {
      input: "/new /home/me/code/site",
      summary: {
        en: "Start a conversation in this absolute path on the host's machine",
        zh: "在 host 所在机器上的这个绝对路径里新建对话",
      },
    },
  ],
  requiredOps: [...NEW_CONVERSATION_OPS],
  run: (ctx, argText) => {
    openNewConversation(ctx, argText === "" ? undefined : argText);
  },
};

export const manageCommands: SlashCommand[] = [
  archiveCommand,
  inviteCommand,
  newCommand,
  removeCommand,
  renameCommand,
  stewardCommand,
  unarchiveCommand,
];
