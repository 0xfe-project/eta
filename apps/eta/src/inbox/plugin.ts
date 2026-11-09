/**
 * The `inbox` plugin: the questions waiting for the user, from every session.
 *
 * One eager target. `list` is the pending questions first and then the recent history, so the
 * pending count is in `hello`. Answering is the one thing to do with a question, and it is a call
 * here rather than on the session so that the row and the run it resumes move together.
 */
import type { InboxResponse } from "@eta/client-contracts";
import type { Inbox } from "./inbox";
import { Args, productPlugin, publish } from "../wire";

export interface InboxPluginDeps {
  inbox: Inbox;
  /** The questions the user-facing Inbox may act on directly. */
  visible?:
    | ((interaction: ReturnType<Inbox["list"]>[number]) => boolean)
    | undefined;
}

/** The longest answer taken: a person's words, not a file. */
const MAX_TEXT = 20_000;

/** The most tools the approval list holds, and the longest name in it. */
const MAX_APPROVALS = 200;
const MAX_TOOL_NAME = 200;

/**
 * The user's answer, read from untrusted JSON into the shape the ask channel takes. Anything else
 * is an error naming what was wrong, because an answer the session cannot read would resume a run
 * on nothing.
 */
function responseOf(raw: unknown): InboxResponse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error("inbox.answer needs a response");
  const value = raw as Record<string, unknown>;
  const text = (key: string): string => {
    const field = value[key];
    if (typeof field !== "string" || field.length > MAX_TEXT)
      throw new Error(`inbox.answer: response.${key} must be a string`);
    return field;
  };
  switch (value.kind) {
    case "selection": {
      const { selections, comment } = value;
      if (
        !Array.isArray(selections) ||
        selections.length === 0 ||
        !selections.every((item) => typeof item === "string")
      )
        throw new Error(
          "inbox.answer: response.selections must be a list of strings",
        );
      if (comment !== undefined && typeof comment !== "string")
        throw new Error("inbox.answer: response.comment must be a string");
      return {
        kind: "selection",
        selections: selections as string[],
        ...(comment === undefined ? {} : { comment }),
      };
    }
    case "freeform": {
      const answer = text("text");
      if (answer.trim() === "")
        throw new Error("inbox.answer: response.text is empty");
      return { kind: "freeform", text: answer };
    }
    case "none":
      return { kind: "none" };
    default:
      throw new Error(
        "inbox.answer: response.kind must be selection, freeform or none",
      );
  }
}

export function inboxPlugin(deps: InboxPluginDeps, applied: () => void) {
  const { inbox } = deps;
  return productPlugin(
    "inbox",
    (ctx) => {
      const { wire, sessions } = ctx;
      const offs = [
        publish(
          wire,
          "inbox",
          {
            list: () =>
              inbox
                .list()
                .filter((interaction) => deps.visible?.(interaction) ?? true),
            approvals: () => ({ tools: inbox.approvals() }),
          },
          { eager: true },
        ),

        wire.handle("inbox", "answer", async (call) => {
          const args = new Args(call);
          const id = args.string("id");
          const response = responseOf(
            (call.args as Record<string, unknown>).response,
          );
          return { result: await inbox.answer(sessions, id, response) };
        }),

        wire.handle("inbox", "setApprovals", (call) => {
          const args = new Args(call);
          // The list is replaced, so a call without one must not quietly empty it.
          if (!Array.isArray(((call.args ?? {}) as { tools?: unknown }).tools))
            throw new TypeError("inbox.setApprovals needs tools");
          const tools = args.strings("tools");
          if (
            tools.length > MAX_APPROVALS ||
            tools.some((tool) => tool.length > MAX_TOOL_NAME)
          )
            throw new Error("inbox.setApprovals: that is too long a list");
          return {
            result: { approvals: { tools: inbox.setApprovals(tools) } },
          };
        }),
      ];
      return () => {
        for (const off of offs.splice(0)) off();
      };
    },
    applied,
  );
}
