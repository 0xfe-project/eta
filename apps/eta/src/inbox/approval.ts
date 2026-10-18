/**
 * Tools that ask before they run: the user's approval list, as a tool middleware.
 *
 * The list is the user's, not a fact about a tool: the same `bash` is one user's whole point and
 * another's thing to approve every time. It is read at every call, so a change reaches sessions
 * that are already open. The asking itself (the question, the answer, the refusal the model
 * reads) is shared with the daemon, whose sessions ask the same way about the same list
 * (`@eta/daemon`, `approval.ts`).
 */
import type { ToolMiddleware } from "@eta/core";
import type { AskRegistry } from "@eta/harness";
import { approvalMiddleware as askBefore } from "@eta/daemon";

export interface ApprovalOptions {
  /** The tool names that need an answer first. Empty means nothing asks. */
  tools: () => readonly string[];
  /** The session's ask channel; without one, a listed tool is refused rather than run. */
  ask: AskRegistry | undefined;
}

export function approvalMiddleware(options: ApprovalOptions): ToolMiddleware {
  return askBefore({
    needsApproval: (name) => options.tools().includes(name),
    ask: options.ask,
  });
}
