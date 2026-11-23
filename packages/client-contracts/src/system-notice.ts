import type { MessageView } from "./product";

/**
 * What a system row says, read from the event it records rather than from its text.
 *
 * The host writes these rows in English, for the agents that read them at their next wake. A
 * client says them in the reader's language: each kind below is one sentence a client translates,
 * with agents named by id so the name is the one the agent has now. `text` is a row whose event
 * this does not know (or whose data is not what the event writes): the client shows the host's
 * words as they are.
 */
export type SystemNotice =
  | { kind: "stewardSet"; to: string }
  | { kind: "stewardChanged"; to: string; from: string }
  | { kind: "stewardCleared"; from: string }
  | { kind: "stewardLeft"; from: string }
  | { kind: "wakeBudget"; budget: number }
  | { kind: "createdByCaptain" }
  | { kind: "routineReport"; name: string; title: string | null }
  | { kind: "text"; text: string };

export function systemNoticeOf(
  message: Pick<MessageView, "data" | "text">,
): SystemNotice {
  const { event, from, to, reason, budget, routineName, title } =
    message.data as {
      event?: unknown;
      from?: unknown;
      to?: unknown;
      reason?: unknown;
      budget?: unknown;
      routineName?: unknown;
      title?: unknown;
    };
  if (event === "steward") {
    if (typeof to === "string" && typeof from === "string")
      return { kind: "stewardChanged", to, from };
    if (typeof to === "string") return { kind: "stewardSet", to };
    if (typeof from === "string")
      return reason === "left"
        ? { kind: "stewardLeft", from }
        : { kind: "stewardCleared", from };
  }
  if (event === "wake_budget" && typeof budget === "number")
    return { kind: "wakeBudget", budget };
  if (event === "captain_created") return { kind: "createdByCaptain" };
  if (event === "routine_report" && typeof routineName === "string")
    return {
      kind: "routineReport",
      name: routineName,
      title: typeof title === "string" && title !== "" ? title : null,
    };
  return { kind: "text", text: message.text };
}
