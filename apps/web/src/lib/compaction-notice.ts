import type { RuntimeCompaction } from "@eta/client-contracts";
import { translate } from "@/lib/i18n";

export interface CompactionNotice {
  level: "success" | "info" | "warning" | "error";
  text: string;
}

const LEVELS = {
  completed: "success",
  empty: "info",
  busy: "info",
  unsupported: "warning",
  aborted: "warning",
  failed: "error",
  unconfirmed: "warning",
} as const satisfies Record<
  RuntimeCompaction["outcome"],
  CompactionNotice["level"]
>;

/** What to tell the user about a `/compact` an external runtime answered. */
export function compactionNotice({
  runtime,
  outcome,
  reason,
}: RuntimeCompaction): CompactionNotice {
  return {
    level: LEVELS[outcome],
    text: translate(`chat:compaction.${outcome}`, { runtime, reason }),
  };
}
