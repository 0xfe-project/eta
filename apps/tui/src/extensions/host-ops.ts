import type { ShellContext } from "./types";
import { translatorFor } from "../i18n/messages";
import { commandLineMessages } from "./command-line";

/**
 * Whether the host has `op`, for a call started from a layer; when it does not, says the host is
 * too old for the command in the status area.
 */
export function hostHas(
  ctx: Pick<ShellContext, "wire" | "notify" | "locale">,
  op: string,
  command: string,
): boolean {
  if (ctx.wire.can(op)) return true;
  ctx.notify(
    translatorFor(commandLineMessages, ctx.locale)("tooOld", {
      name: command,
      ops: op,
    }),
    "error",
  );
  return false;
}
