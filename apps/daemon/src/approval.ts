/**
 * Tools that ask before they run.
 *
 * The kernel's tool chain has one place where a call can be stopped before it happens
 * (`ToolMiddleware.before`), and this puts a question there. It is the channel the model's own
 * `ask_user` uses: the question is a row in the inbox, and the answer comes back through
 * `inbox.answer`. What differs is only who asks, a tool the user marked rather than the model.
 *
 * Which tools ask is the user's list, not a fact about a tool, and it is read at every call, so a
 * change reaches sessions that are already open. On the primary that is a read of its database;
 * on a daemon it is a question to the primary. This file is the same for both, which is why it
 * lives here: the host's approvals and a remote session's are one policy.
 *
 * A refusal is not a failure: the call is blocked with a reason the model reads, and the run
 * carries on with it.
 */
import type { ToolMiddleware } from "@eta/core";
import type { AskRegistry } from "@eta/harness";

const ALLOW = "allow";
const DENY = "deny";

/** The most of a call's arguments the question shows. */
const MAX_ARGUMENTS = 500;

export interface ApprovalOptions {
  /** Whether this tool needs an answer first. A throw is a refusal: the list could not be read. */
  needsApproval: (name: string) => boolean | Promise<boolean>;
  /** The session's ask channel; without one, a listed tool is refused rather than run. */
  ask: AskRegistry | undefined;
}

function questionFor(name: string, args: unknown): string {
  const json = JSON.stringify(args) ?? "";
  if (json === "" || json === "{}") return `Run the \`${name}\` tool?`;
  const shown =
    json.length <= MAX_ARGUMENTS ? json : `${json.slice(0, MAX_ARGUMENTS)}...`;
  return `Run the \`${name}\` tool with ${shown}?`;
}

export function approvalMiddleware(options: ApprovalOptions): ToolMiddleware {
  return {
    name: "approval",
    before: async (name, args, call) => {
      try {
        if (!(await options.needsApproval(name))) return { ok: true, args };
      } catch (error) {
        return {
          ok: false,
          blockReason: `\`${name}\` was not run: whether it needs the user's approval could not be checked (${error instanceof Error ? error.message : String(error)})`,
        };
      }
      if (options.ask === undefined) {
        // No channel to ask through: saying no is the only honest answer, and the model is told
        // why rather than left to wonder whether the tool exists.
        return {
          ok: false,
          blockReason: `the user must approve \`${name}\`, and this session has no way to ask`,
        };
      }
      const response = await options.ask.ask(
        {
          // The tool call's own id: the question and the call are one exchange.
          questionId: call.toolCallId,
          question: questionFor(name, args),
          options: [ALLOW, DENY],
        },
        { ...(call.signal === undefined ? {} : { signal: call.signal }) },
      );
      if (
        (response.kind === "selection" &&
          response.selections.includes(ALLOW)) ||
        (response.kind === "freeform" && response.text.trim() === ALLOW)
      )
        return { ok: true, args };
      // `none` is the run being cancelled or the user declining; both mean no here.
      return { ok: false, blockReason: `the user did not approve \`${name}\`` };
    },
  };
}
