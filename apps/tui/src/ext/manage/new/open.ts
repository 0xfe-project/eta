import type { ShellContext } from "../../../extensions/types";
import { createElement } from "react";
import { agentsOf } from "../../../extensions/eager-lists";
import { translatorFor } from "../../../i18n/messages";
import { ordinaryAgents } from "../../kit/captain";
import { manageMessages } from "../messages";
import { NewConversationLayer } from "./layer";

/** The ops `/new` calls. */
export const NEW_CONVERSATION_OPS = [
  "projects.directories",
  "projects.create",
  "conversations.create",
] as const;

/**
 * Opens the layer that starts a conversation; `path`, when given, is taken as typed into it. With
 * no agent at all, says to create one and opens nothing.
 */
export function openNewConversation(
  ctx: ShellContext,
  path: string | undefined,
): void {
  if (ordinaryAgents(agentsOf(ctx.wire.store.getState())).length === 0) {
    ctx.notify(translatorFor(manageMessages, ctx.locale)("noAgents"), "error");
    return;
  }
  ctx.openLayer((handle) =>
    createElement(NewConversationLayer, { startPath: path, handle }),
  );
}
