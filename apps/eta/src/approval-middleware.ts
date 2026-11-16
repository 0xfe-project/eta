import type { ToolMiddleware } from "@eta/core";
import type {
  AskRegistry,
  AuthorizationRequest,
  EsmAuthorizer,
  McpSink,
} from "@eta/harness";
import type { SessionManagerOptions } from "@eta/server";
import type { Inbox } from "./inbox/inbox";

/**
 * The approval list, as actual policy, on both seams a session's actions pass:
 *
 * - the kernel's tools (`approvalMiddleware`): a tool the model calls, by its own name;
 * - the realm (`approvalAuthorizer`): what a script reaches from `esmrun`. An MCP tool by
 *   `mcp.<server>.<tool>`, a shell command as `shell`, every file write (`fs.writeFile`,
 *   `fs.rm`, `edit`…) as `fs.write`, and any other binding by its own name.
 *
 * An entry ending in `.*` names everything under it (`mcp.github.*`). The Inbox owns the names;
 * both seams ask through the session's own ask channel, so a pending approval is an ordinary
 * durable Inbox question. An MCP server's own `approveTools` (in its `mcp.json`) asks the same
 * way, on the same card.
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
        const refusal = await askApproval(session.ask, {
          questionId: `approval:${call.toolCallId}`,
          name,
          signal: call.signal,
        });
        return refusal === undefined
          ? { ok: true, args }
          : { ok: false, blockReason: refusal };
      },
    } satisfies ToolMiddleware,
  ];
}

/** Every realm binding that changes a file: one name on the list covers them. */
const FILE_WRITES = new Set([
  "fs.writeFile",
  "fs.appendFile",
  "fs.mkdir",
  "fs.rm",
  "fs.rename",
  "fs.copyFile",
  "fs.writeFileSync",
  "fs.appendFileSync",
  "fs.mkdirSync",
  "fs.rmSync",
  "edit",
]);

/** The writes whose first two arguments are both paths. */
const TWO_PATHS = new Set(["fs.rename", "fs.copyFile"]);

/** The approval-list names a realm call answers to: its own, and the group it belongs to. */
function realmApprovalNames(name: string): string[] {
  return FILE_WRITES.has(name) ? [name, "fs.write"] : [name];
}

/** Whether the list asks about this realm call. */
function realmCallIsListed(list: readonly string[], name: string): boolean {
  // `eta.platform.<tool>` reaches the kernel's tools, where the middleware already asks; the
  // shared layers' capabilities (`capability.*`) are not on the list's terms.
  if (name.startsWith("eta.platform.") || name.startsWith("capability."))
    return false;
  const names = realmApprovalNames(name);
  return list.some((entry) =>
    entry.endsWith(".*")
      ? names.some((candidate) => candidate.startsWith(entry.slice(0, -1)))
      : names.includes(entry),
  );
}

/** What the call is about, for the second line of the question. */
function describeRealmCall(request: AuthorizationRequest): string {
  const { name, input } = request;
  // The command, or the paths: never what is written, which can be a whole file.
  if (name === "shell" || FILE_WRITES.has(name))
    return input
      .slice(0, TWO_PATHS.has(name) ? 2 : 1)
      .map(String)
      .join(" → ");
  let text: string;
  try {
    text = JSON.stringify(input.length === 1 ? input[0] : input) ?? "";
  } catch {
    text = "";
  }
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/** Whether `mcp.<server>.<tool>` is a tool its server's `approveTools` covers. */
function mcpRequiresApproval(mcp: McpSink | undefined, name: string): boolean {
  if (mcp?.requiresApproval === undefined || !name.startsWith("mcp."))
    return false;
  const rest = name.slice("mcp.".length);
  // A server's name can hold a dot; the longest one that prefixes the rest is the server.
  const server = mcp
    .servers()
    .map((info) => info.name)
    .filter((candidate) => rest.startsWith(`${candidate}.`))
    .sort((a, b) => b.length - a.length)[0];
  return (
    server !== undefined &&
    mcp.requiresApproval(server, rest.slice(server.length + 1))
  );
}

/**
 * The approval list on the realm's seam: a listed call, or an MCP tool its server's
 * `approveTools` covers, waits for the user's answer. A synchronous binding
 * (`fs.writeFileSync`) cannot wait, so a listed one is refused with a pointer to its async form.
 */
export function approvalAuthorizer(
  inbox: Inbox,
): NonNullable<SessionManagerOptions["realmAuthorizer"]> {
  return ({ session, mcp }): EsmAuthorizer =>
    (request, call) => {
      const { name } = request;
      if (
        !realmCallIsListed(inbox.approvals(), name) &&
        !mcpRequiresApproval(mcp, name)
      )
        return undefined;
      if (name.endsWith("Sync"))
        return `${name} is on the approval list, and a synchronous call cannot wait for the answer; use the async form (node:fs/promises)`;
      const detail = describeRealmCall(request);
      return askApproval(session().ask, {
        questionId: `approval:${call.callId}`,
        name,
        ...(detail === "" ? {} : { detail }),
        signal: call.signal,
      });
    };
}

/** Asks the user whether `name` may run: undefined when allowed, the refusal otherwise. */
async function askApproval(
  ask: AskRegistry | undefined,
  question: {
    questionId: string;
    name: string;
    detail?: string;
    signal: AbortSignal | undefined;
  },
): Promise<string | undefined> {
  const { name } = question;
  if (ask === undefined)
    return `${name} is on the approval list but this session has no ask channel`;
  const answer = await ask.ask(
    {
      questionId: question.questionId,
      question:
        question.detail === undefined
          ? `Approve running ${name}?`
          : `Approve running ${name}?\n${question.detail}`,
      options: ["allow", "deny"],
    },
    question.signal === undefined ? {} : { signal: question.signal },
  );
  const approved =
    (answer.kind === "selection" &&
      answer.selections.some(
        (selection) => selection.toLowerCase() === "allow",
      )) ||
    (answer.kind === "freeform" &&
      answer.text.trim().toLowerCase() === "allow");
  return approved ? undefined : `The user did not approve ${name}.`;
}
