/**
 * Tools that ask before they run (REFACTOR.md §9, P2.6 — 审批 = ask).
 *
 * The kernel's tool chain has one place where a call can be stopped before it happens
 * (`ToolMiddleware.before`), and this is what puts a question there. It is the same channel the
 * model's own `ask_user` uses: the question is a row, a card in the client, and the answer comes
 * back through `AskBridge`. What differs is only who asks — a tool the user marked, not the model.
 *
 * The list is configuration, because "which tools are dangerous" is not a fact about a tool: the
 * same `bash` is one user's whole point and another user's thing to approve every time.
 *
 * A denial is not a failure: the call is blocked with a reason the model reads, and the run carries
 * on with it — the model sees "the user declined" the same way it sees any other tool result.
 */
import type { ToolMiddleware } from "@eta/core";
import type { AskPayload } from "@eta/core/session";
import type { AskRegistry } from "@eta/harness";
import type { SessionMeta } from "@eta/server";

export const ALLOW = "allow";
export const DENY = "deny";

export interface ApprovalOptions {
  /** The tool names that need an answer first. Empty means nothing asks. */
  tools: readonly string[];
  /** The session's ask channel; without one, a listed tool is refused rather than run. */
  ask: AskRegistry | undefined;
  meta: SessionMeta;
}

/**
 * The middleware, or `undefined` when nothing is on the list.
 *
 * Returning `undefined` rather than a middleware that always says yes keeps the chain short: a host
 * that approves nothing pays nothing.
 */
export function approvalMiddleware(
  options: ApprovalOptions,
): ToolMiddleware | undefined {
  if (options.tools.length === 0) return undefined;
  const listed = new Set(options.tools);
  return {
    name: "approval",
    before: async (name, args, call) => {
      if (!listed.has(name)) return { ok: true, args };
      const payload: AskPayload = {
        // The tool call's own id: the card, the journal entry and the call are one exchange.
        questionId: call.toolCallId,
        question: `Run the \`${name}\` tool?`,
        options: [ALLOW, DENY],
      };
      if (options.ask === undefined) {
        // No channel to ask through: saying no is the only honest answer, and the model is told
        // why rather than left to wonder whether the tool exists.
        return {
          ok: false,
          blockReason: `the user must approve \`${name}\`, and this session has no way to ask`,
        };
      }
      const response = await options.ask.ask(payload, {
        ...(call.signal === undefined ? {} : { signal: call.signal }),
      });
      if (
        response.kind === "selection" &&
        response.selections.includes(ALLOW)
      ) {
        return { ok: true, args };
      }
      if (response.kind === "freeform" && response.text.trim() === ALLOW) {
        return { ok: true, args };
      }
      // `none` is the deadline or the run being cancelled; both mean the same thing here.
      return {
        ok: false,
        blockReason: `the user did not approve \`${name}\``,
      };
    },
  };
}
