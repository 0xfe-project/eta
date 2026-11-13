import type { LlmQuota } from "@eta/client-contracts";
import type { ReactNode } from "react";
import type { SourceStatus } from "@/queries/sources";
import { useTranslation } from "react-i18next";
import { llmProblemText } from "@/lib/llm-problem";
import { cn } from "@/lib/utils";
import { resetText, windowLabel } from "./llm-state";
import { statusText } from "./source-text";

// The small pieces every view of a model source shares: its tile, its status, how it connects,
// and what is left of a subscription.

/** A square with the name's first letter: there are no logos to ship, and a letter tells rows apart. */
export function SourceLogo({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-6 shrink-0 place-items-center bg-muted text-[11px] font-semibold uppercase",
        className,
      )}
    >
      {Array.from(name.trim())[0] ?? "?"}
    </span>
  );
}

const DOTS: Record<SourceStatus, string> = {
  ok: "bg-state-success",
  needs_key: "bg-state-warning",
  needs_login: "bg-state-warning",
  disabled: "bg-faint",
  invalid_key: "bg-state-error",
  unreachable: "bg-state-error",
};

/** A status as a small square of its colour and its word: the colour alone says nothing to some. */
export function StatusLabel({
  status,
  className,
}: {
  status: SourceStatus;
  className?: string;
}) {
  useTranslation(["providers"] as const);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs whitespace-nowrap",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 shrink-0", DOTS[status])}
      />
      {statusText(status)}
    </span>
  );
}

/** The shortest window a subscription reports: what runs out first. */
function firstWindow(quota: LlmQuota | undefined) {
  return (
    quota?.windows.find((window) => window.kind === "5h") ?? quota?.windows[0]
  );
}

/** One bar for a row: how much of the subscription's shortest window is left. */
export function QuotaMeter({ quota }: { quota: LlmQuota | undefined }) {
  const { t: translateText } = useTranslation(["llm"] as const);
  const window = firstWindow(quota);
  if (window === undefined) return null;
  const left = Math.round(100 - window.used);
  const label = windowLabel(window.kind);
  return (
    <span className="hidden items-center gap-1.5 text-[11px] text-muted-foreground sm:inline-flex">
      {label}
      <span
        role="meter"
        aria-label={translateText("quota.remainingLabel", { label })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={left}
        className="h-1 w-14 bg-muted"
      >
        <span
          className={cn(
            "block h-full",
            left <= 10 ? "bg-state-error" : "bg-muted-foreground",
          )}
          style={{ width: `${left}%` }}
        />
      </span>
    </span>
  );
}

/** Every window a subscription reports, with what is left and when it resets. */
export function QuotaWindows({ quota }: { quota: LlmQuota }) {
  const { t: translateText } = useTranslation(["llm", "common"] as const);
  if (quota.error)
    return (
      <p className="text-xs text-muted-foreground">
        {llmProblemText(quota.error)}
      </p>
    );
  if (quota.windows.length === 0) return null;
  return (
    <dl className="grid max-w-md grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 text-xs">
      {quota.windows.map((window) => {
        const left = Math.round(100 - window.used);
        const label = windowLabel(window.kind);
        return (
          <div key={window.kind} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd
              role="meter"
              aria-label={translateText("quota.remainingLabel", { label })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={left}
              className="h-1.5 bg-muted"
            >
              <div
                className={cn(
                  "h-full",
                  left <= 10 ? "bg-state-error" : "bg-foreground/70",
                )}
                style={{ width: `${left}%` }}
              />
            </dd>
            <dd className="text-right tabular-nums text-muted-foreground">
              <span className="text-foreground">
                {translateText("quota.remainingPercent", { percent: left })}
              </span>
              {window.resetsAt
                ? translateText("common:format.inlineSeparator", {
                    label:
                      resetText(window.resetsAt) ||
                      translateText("quota.resetsSoon"),
                  })
                : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

export function Tag({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "border px-1 text-[10.5px] whitespace-nowrap text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}
