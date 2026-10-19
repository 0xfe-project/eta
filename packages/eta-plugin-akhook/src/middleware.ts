/**
 * Tool-call rules as a `ToolMiddleware`.
 *
 * `before` is the one place a call can be stopped before it happens: the rules decide `deny`
 * (the call is blocked, the model reads why) or `ask` (the question goes through the session's
 * ask channel, so it is a card in the inbox, and the answer comes back through the same door as
 * the model's own `ask_user`). There is no one-time grant file as in akhook: the channel is the
 * grant. `after` is where a streaming rule's soft reminder rides with the tool's result.
 *
 * The user's approval list (tools that always ask) is the same mechanism with a different
 * source: an approved tool contributes an `ask` hit of its own, so a call that both a rule and the
 * list want to ask about is one question, not two.
 */
import type { ToolMiddleware } from "@eta/core";
import type { AskRegistry } from "@eta/harness";
import type { RuleHit } from "./rules";
import type { RuleSource } from "./source";
import type { StreamRules } from "./stream";
import { candidatesOf } from "./candidates";

/** The id the approval list's own hit carries. */
const APPROVAL = "approval";
const ALLOW = "allow";
const DENY = "deny";

/** The most of a call's arguments a question shows. */
const MAX_ARGUMENTS = 500;

export interface AkhookMiddlewareOptions {
  /** The rules; without it only the approval list is in force. */
  source?: RuleSource | undefined;
  /** The session's working directory, for the paths a call names. */
  cwd?: string | undefined;
  /** The session's ask channel; without one, a call that needs an answer is refused. */
  ask: AskRegistry | undefined;
  /**
   * Whether this tool needs the user's approval, read at every call. A throw is a refusal: the
   * list could not be read.
   */
  approvals?: ((name: string) => boolean | Promise<boolean>) | undefined;
  /** Streaming rules whose soft reminders ride with tool results. */
  streams?: StreamRules | undefined;
}

function argumentsText(args: unknown): string {
  const json = JSON.stringify(args) ?? "";
  if (json === "" || json === "{}") return "";
  return json.length <= MAX_ARGUMENTS
    ? json
    : `${json.slice(0, MAX_ARGUMENTS)}...`;
}

/** The question the user sees for a call. */
export function questionFor(
  name: string,
  args: unknown,
  hits: readonly RuleHit[],
): string {
  const shown = argumentsText(args);
  const run =
    shown === ""
      ? `Run the \`${name}\` tool?`
      : `Run the \`${name}\` tool with ${shown}?`;
  const rules = hits.filter((hit) => hit.id !== APPROVAL);
  if (rules.length === 0) return run;
  return `${rules.map((hit) => `${hit.id}: ${hit.message}`).join("\n")}\n\n${run}`;
}

function refusal(hits: readonly RuleHit[]): string {
  return hits.map((hit) => `- ${hit.id}: ${hit.message}`).join("\n");
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Append `text` to whatever a tool returned, in the shape it returned it. */
export function appendToResult(result: unknown, text: string): unknown {
  if (typeof result === "string") return `${result}\n\n${text}`;
  if (typeof result === "object" && result !== null) {
    const record = result as { content?: unknown };
    if (Array.isArray(record.content))
      return {
        ...record,
        content: [...record.content, { type: "text", text }],
      };
  }
  return {
    content: [
      {
        type: "text",
        text:
          typeof result === "string" ? result : (JSON.stringify(result) ?? ""),
      },
      { type: "text", text },
    ],
  };
}

export function akhookMiddleware(
  options: AkhookMiddlewareOptions,
): ToolMiddleware {
  return {
    name: "akhook",
    before: async (name, args, call) => {
      const block = (blockReason: string) => {
        options.streams?.dropFor(call.toolCallId);
        return { ok: false as const, blockReason };
      };
      const hits: RuleHit[] = [];

      if (options.source !== undefined) {
        try {
          const rules = options.source.get();
          const decision = await rules.evaluate(
            candidatesOf(name, args, options.cwd ?? rules.root),
          );
          if (decision.kind === "deny")
            return block(`blocked by akhook:\n${refusal(decision.hits)}`);
          if (decision.kind === "ask") hits.push(...decision.hits);
        } catch (error) {
          // akhook never lets a call through on a rule it could not read or run.
          return block(
            `\`${name}\` was not run: akhook could not check it (${messageOf(error)})`,
          );
        }
      }

      if (options.approvals !== undefined) {
        try {
          if (await options.approvals(name))
            hits.push({ id: APPROVAL, message: "", action: "ask" });
        } catch (error) {
          return block(
            `\`${name}\` was not run: whether it needs the user's approval could not be checked (${messageOf(error)})`,
          );
        }
      }
      if (hits.length === 0) return { ok: true as const, args };

      if (options.ask === undefined) {
        // No channel to ask through: saying no is the only honest answer, and the model is told
        // why rather than left to wonder whether the tool exists.
        return block(
          `the user must approve \`${name}\`, and this session has no way to ask`,
        );
      }
      const response = await options.ask.ask(
        {
          // The tool call's own id: the question and the call are one exchange.
          questionId: call.toolCallId,
          question: questionFor(name, args, hits),
          options: [ALLOW, DENY],
        },
        { ...(call.signal === undefined ? {} : { signal: call.signal }) },
      );
      if (
        (response.kind === "selection" &&
          response.selections.includes(ALLOW)) ||
        (response.kind === "freeform" && response.text.trim() === ALLOW)
      )
        return { ok: true as const, args };
      // `none` is the run being cancelled or the user declining; both mean no here.
      return block(`the user did not approve \`${name}\``);
    },
    after: (_name, _args, result, call) => {
      const reminder = options.streams?.reminderFor(call.toolCallId);
      return reminder === undefined ? result : appendToResult(result, reminder);
    },
  };
}
