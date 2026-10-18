import type {
  ApprovalList,
  InboxArgs,
  InboxResponse,
  InboxResults,
  InteractionView,
} from "@eta/client-contracts";
import { useMemo } from "react";
import { useListTarget, useTarget, useWireMutation } from "@/queries/wire";

// The `inbox` target: every question an agent's session asks, pending first and then the latest
// settled ones, and the list of tools that ask before they run. It is eager, so the pending count
// is in `hello` and the indicators draw before anything is asked.

export type { InboxResponse, InteractionView };

const NONE: InteractionView[] = [];

/** The inbox's rows: the pending ones (newest first), then the recent settled ones. */
export function useInbox() {
  const { items, loaded, error } = useListTarget<InteractionView>("inbox");
  return { interactions: items, loaded, error };
}

/** The questions waiting for the user, from every session. */
export function usePendingInteractions(): InteractionView[] {
  const { interactions } = useInbox();
  return useMemo(() => {
    const pending = interactions.filter((row) => row.status === "pending");
    return pending.length === 0 ? NONE : pending;
  }, [interactions]);
}

/** Answer a pending question (`none` declines it); the run waiting on it goes on. */
export function useAnswerInteraction() {
  return useWireMutation<
    { id: string; response: InboxResponse },
    InboxResults["answer"]
  >("inbox", "answer");
}

const NO_TOOLS: string[] = [];

/** The tool names that ask the user before they run. */
export function useApprovals(): string[] {
  const approvals = useTarget("inbox")?.sections.approvals as
    | ApprovalList
    | undefined;
  return approvals?.tools ?? NO_TOOLS;
}

/** Replace the approval list. */
export function useSetApprovals() {
  return useWireMutation<
    InboxArgs["setApprovals"],
    InboxResults["setApprovals"]
  >("inbox", "setApprovals");
}
