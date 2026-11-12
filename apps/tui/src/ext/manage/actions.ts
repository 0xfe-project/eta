/**
 * What the management commands ask of the host, each followed by a line in the status area.
 * Each rejects with the host's error and says nothing then.
 */
import type { ConversationSummary } from "@eta/client-contracts";
import type { ShellContext } from "../../extensions/types";
import type { NamedAgent } from "./facts";
import { translatorFor } from "../../i18n/messages";
import { manageMessages } from "./messages";

type Ctx = Pick<ShellContext, "wire" | "notify" | "locale">;

const texts = (ctx: Pick<ShellContext, "locale">) =>
  translatorFor(manageMessages, ctx.locale);

interface Updated {
  conversation: ConversationSummary;
}

function update(
  ctx: Ctx,
  conversationId: string,
  change: { name: string } | { archived: boolean },
): Promise<Updated> {
  return ctx.wire.call<Updated>("conversations", "update", {
    conversationId,
    ...change,
  });
}

export async function rename(
  ctx: Ctx,
  conversationId: string,
  name: string,
): Promise<void> {
  const { conversation } = await update(ctx, conversationId, { name });
  ctx.notify(texts(ctx)("renamed", { name: conversation.name }), "info");
}

export async function setArchived(
  ctx: Ctx,
  conversationId: string,
  archived: boolean,
): Promise<ConversationSummary> {
  const { conversation } = await update(ctx, conversationId, { archived });
  ctx.notify(
    texts(ctx)(archived ? "archived" : "unarchived", {
      name: conversation.name,
    }),
    "info",
  );
  return conversation;
}

export async function invite(
  ctx: Ctx,
  conversationId: string,
  agent: NamedAgent,
): Promise<void> {
  const { conversation } = await ctx.wire.call<Updated>(
    "conversations",
    "invite",
    { conversationId, agentId: agent.id },
  );
  ctx.notify(
    texts(ctx)("invited", {
      name: agent.name,
      conversation: conversation.name,
    }),
    "info",
  );
}

export async function remove(
  ctx: Ctx,
  conversationId: string,
  agent: NamedAgent,
): Promise<void> {
  const { conversation } = await ctx.wire.call<Updated>(
    "conversations",
    "remove",
    { conversationId, agentId: agent.id },
  );
  ctx.notify(
    texts(ctx)("removed", {
      name: agent.name,
      conversation: conversation.name,
    }),
    "info",
  );
}

/** A member, the project's steward, or none at all. */
export type StewardChoice =
  | { kind: "agent"; agent: NamedAgent }
  | { kind: "project" }
  | { kind: "none" };

export async function setSteward(
  ctx: Ctx,
  conversationId: string,
  choice: StewardChoice,
): Promise<void> {
  const args =
    choice.kind === "agent"
      ? { conversationId, agentId: choice.agent.id }
      : choice.kind === "project"
        ? { conversationId, agentId: null }
        : { conversationId, agentId: null, none: true };
  const { conversation } = await ctx.wire.call<Updated>(
    "conversations",
    "setSteward",
    args,
  );
  const t = texts(ctx);
  const name = conversation.name;
  ctx.notify(
    choice.kind === "agent"
      ? t("stewardSet", { name: choice.agent.name, conversation: name })
      : choice.kind === "project"
        ? t("stewardFollows", { conversation: name })
        : t("stewardNone", { conversation: name }),
    "info",
  );
}
