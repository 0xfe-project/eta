import type { CaptainOperationStatus } from "@eta/client-contracts";
import { StateMark } from "./state-mark";

/**
 * Where a proposed operation stands, at the right end of its line: a square and a word. Waiting for
 * you to press Create is not a warning, so it is grey; only the outcome has a colour — created, or
 * failed. The word is the caller's: a group proposal and an agent proposal each name their own.
 */
export function OperationStatusMark({
  status,
  label,
}: {
  status: CaptainOperationStatus;
  label: string;
}) {
  return (
    <StateMark
      tone={
        status === "applied"
          ? "success"
          : status === "failed"
            ? "error"
            : "neutral"
      }
      className="ml-auto shrink-0 text-muted-foreground"
    >
      {label}
    </StateMark>
  );
}
