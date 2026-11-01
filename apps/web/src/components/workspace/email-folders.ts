import type { EmailThreadView } from "@eta/client-contracts";

export type EmailFolder = "inbox" | "sent";

export function emailThreadsForFolder(
  threads: readonly EmailThreadView[],
  folder: EmailFolder,
): EmailThreadView[] {
  const directionsKnown = threads.every(
    (thread) =>
      typeof thread.incomingCount === "number" &&
      typeof thread.outgoingCount === "number",
  );
  if (!directionsKnown) return folder === "inbox" ? [...threads] : [];
  return threads.filter((thread) =>
    folder === "inbox" ? thread.incomingCount > 0 : thread.outgoingCount > 0,
  );
}
