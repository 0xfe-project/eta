import type { ReactNode } from "react";
import { displayContext } from "@eta/client-contracts";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { compactionNotice } from "@/lib/compaction-notice";
import { useSession, useSessionActions } from "@/queries/sessions";
import { when } from "./routine-format";

export function MemberRing({
  sessionId,
  children,
  size = 48,
}: {
  sessionId: string;
  children: ReactNode;
  /** The ring's box in px. The viewBox stays 48, so the geometry below scales with it. */
  size?: number;
}) {
  const { i18n, t } = useTranslation("chat");
  const current = displayContext(
    useSession(sessionId)?.context,
    sessionId,
    i18n.language,
  );
  const circumference = 2 * Math.PI * 20;
  const length = current.fraction * circumference;
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
      title={t("usage.ring", { detail: current.detail })}
    >
      <svg
        viewBox="0 0 48 48"
        aria-hidden="true"
        className="absolute inset-0 -rotate-90"
        style={{ width: size, height: size }}
      >
        <circle
          cx="24"
          cy="24"
          r="20"
          fill="none"
          stroke="var(--overlay)"
          strokeWidth="3"
        />
        {length > 0 && (
          <circle
            cx="24"
            cy="24"
            r="20"
            fill="none"
            stroke="var(--state-info)"
            strokeWidth="3"
            strokeDasharray={`${length} ${circumference - length}`}
          />
        )}
      </svg>
      {children}
    </span>
  );
}

/**
 * A member's ring as a button: it opens a small panel with how full the context is, when it was
 * last compacted, and the way to compact it — this member's session in this conversation. What
 * `/compact` used to do from the composer, where the ring that measures it already is.
 */
export function MemberContext({
  sessionId,
  name,
  runtime,
  children,
}: {
  sessionId: string;
  name: string;
  /** The member's runtime: one other than eta compacts out of sight, so a toast says how it went. */
  runtime: string | undefined;
  children: ReactNode;
}) {
  const { t: translateText, i18n } = useTranslation(["chat"] as const);
  const view = useSession(sessionId);
  const reading = view?.context;
  const compacted = reading?.compactedAt;
  const current = displayContext(reading, sessionId, i18n.language);
  const { compact } = useSessionActions();
  function run() {
    // A runtime's compaction leaves nothing in the transcript, so a toast tells how it went.
    const waiting =
      runtime !== undefined && runtime !== "eta"
        ? toast.loading(translateText("compaction.running"))
        : undefined;
    compact.mutateAsync({ session: sessionId }).then(
      ({ runtime: outcome }) => {
        if (outcome === undefined) {
          if (waiting !== undefined) toast.dismiss(waiting);
          return;
        }
        const { level, text } = compactionNotice(outcome);
        toast[level](text, { id: waiting });
      },
      (error: Error) => {
        // With no id this would dismiss every toast on the screen.
        if (waiting !== undefined) toast.dismiss(waiting);
        toast.error(error.message);
      },
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="shrink-0 cursor-pointer focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
          aria-label={translateText("compactPanel.open", { name })}
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 gap-2 p-2.5">
        <div className="text-muted-foreground tabular-nums">
          <p>{current.detail}</p>
          <p>
            {compacted == null
              ? translateText("compactPanel.never")
              : translateText("compactPanel.lastCompacted", {
                  time: when(compacted),
                })}
          </p>
        </div>
        <div>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={compact.isPending}
            onClick={run}
          >
            {compact.isPending
              ? translateText("compaction.running")
              : translateText("compactPanel.compact")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
