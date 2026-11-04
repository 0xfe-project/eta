import type { ToolMiddleware } from "@eta/core";
import type { SessionManagerOptions } from "@eta/server";
import type { Inbox } from "./inbox/inbox";

/**
 * The approval list, as actual policy. The Inbox owns the names; this middleware asks through the
 * session's own ask channel, so a pending approval is an ordinary durable Inbox question.
 */
export function approvalMiddleware(
  inbox: Inbox,
): NonNullable<SessionManagerOptions["toolMiddleware"]> {
  return ({ session }) => [
    {
      name: "approvals",
      async before(
        name: string,
        args: unknown,
        call,
      ): Promise<
        { ok: true; args: unknown } | { ok: false; blockReason: string }
      > {
        if (!inbox.approvals().includes(name)) return { ok: true, args };
        const ask = session.ask;
        if (ask === undefined)
          return {
            ok: false,
            blockReason: `${name} is on the approval list but this session has no ask channel`,
          };
        const answer = await ask.ask(
          {
            questionId: `approval:${call.toolCallId}`,
            question: `Approve running ${name}?`,
            options: ["allow", "deny"],
          },
          {
            ...(call.signal === undefined ? {} : { signal: call.signal }),
          },
        );
        const approved =
          (answer.kind === "selection" &&
            answer.selections.some(
              (selection) => selection.toLowerCase() === "allow",
            )) ||
          (answer.kind === "freeform" &&
            answer.text.trim().toLowerCase() === "allow");
        return approved
          ? { ok: true, args }
          : {
              ok: false,
              blockReason: `The user did not approve ${name}.`,
            };
      },
    } satisfies ToolMiddleware,
  ];
}
