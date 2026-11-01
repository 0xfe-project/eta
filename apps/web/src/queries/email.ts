import type {
  EmailArgs,
  EmailInboxSections,
  EmailProposalView,
  EmailResults,
  EmailThreadSections,
} from "@eta/client-contracts";
import { useTarget, useWireMutation, useWireState } from "./wire";

const EMPTY_PROPOSALS: readonly EmailProposalView[] = [];

export function useEmail() {
  const mounted = useWireState((state) =>
    state.mounted.some(
      (plugin) => plugin.name === "email" && plugin.error === undefined,
    ),
  );
  const sections = useTarget("email")?.sections as
    | EmailInboxSections
    | undefined;
  return {
    mounted,
    loaded: sections !== undefined,
    accounts: sections?.accounts ?? [],
    threads: sections?.threads ?? [],
    proposals: sections?.proposals ?? EMPTY_PROPOSALS,
    stats: sections?.stats ?? { unread: 0, pendingProposals: 0 },
  };
}

export function useEmailThread(threadId: string | undefined) {
  const sections = useTarget(
    threadId === undefined ? undefined : `email.${threadId}`,
  )?.sections as EmailThreadSections | undefined;
  return {
    thread: sections?.thread,
    messages: sections?.messages ?? [],
    assignments: sections?.assignments ?? [],
    proposals: sections?.proposals ?? EMPTY_PROPOSALS,
  };
}

export function useSaveEmailAccount() {
  return useWireMutation<EmailArgs["saveAccount"], EmailResults["saveAccount"]>(
    "email",
    "saveAccount",
    { timeoutMs: 45_000 },
  );
}

export function useVerifyEmailAccount() {
  return useWireMutation<
    EmailArgs["verifyAccount"],
    EmailResults["verifyAccount"]
  >("email", "verifyAccount", { timeoutMs: 45_000 });
}

export function useRemoveEmailAccount() {
  return useWireMutation<
    EmailArgs["removeAccount"],
    EmailResults["removeAccount"]
  >("email", "removeAccount");
}

export function useRefreshEmail() {
  return useWireMutation<EmailArgs["refresh"], EmailResults["refresh"]>(
    "email",
    "refresh",
    { timeoutMs: 45_000 },
  );
}

export function useMarkEmailRead() {
  return useWireMutation<EmailArgs["markRead"], EmailResults["markRead"]>(
    "email",
    "markRead",
  );
}

export function useDeleteEmails() {
  return useWireMutation<
    EmailArgs["deleteThreads"],
    EmailResults["deleteThreads"]
  >("email", "deleteThreads");
}

export function useAssignEmail() {
  return useWireMutation<EmailArgs["assign"], EmailResults["assign"]>(
    "email",
    "assign",
    { timeoutMs: 45_000 },
  );
}

export function useConfirmEmailProposal() {
  return useWireMutation<
    EmailArgs["confirmProposal"],
    EmailResults["confirmProposal"]
  >("email", "confirmProposal", { timeoutMs: 45_000 });
}

export function useDiscardEmailProposal() {
  return useWireMutation<
    EmailArgs["discardProposal"],
    EmailResults["discardProposal"]
  >("email", "discardProposal");
}
