import type { ReactNode } from "react";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { cn } from "cn";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { noteItems } from "./release-notes";

// The pieces Settings → Update is drawn from, for the desktop app and the host alike: one thin
// bar that says what this is, which version, and what can be done, then whatever goes under it.
// Sized for the settings dialog: 13px for the version, 12px and 11px around it.

/** The colour a state is said in. */
export type UpdateTone = "success" | "info" | "warning" | "muted" | "error";

const DOT: Record<UpdateTone, string> = {
  success: "bg-state-success",
  info: "bg-state-info",
  warning: "bg-state-warning",
  muted: "bg-faint",
  error: "bg-state-error",
};

/** What it is, its version (and the one it would go to), its state, and the buttons on the right. */
export function UpdateStatusBar({
  title,
  version,
  target,
  tone,
  state,
  actions,
  meta,
  className,
}: {
  title: string;
  version: string;
  /** The version an update would bring: `version → target`. */
  target?: string | undefined;
  tone: UpdateTone;
  state: string;
  actions?: ReactNode;
  /** Small words under the buttons: when it was last checked. */
  meta?: string | undefined;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border border-border px-3 py-2",
        className,
      )}
    >
      <div className="text-[11px] leading-4 text-muted-foreground">{title}</div>
      <div className="text-[13px] leading-5 font-medium break-all">
        {version}
        {target !== undefined && (
          <>
            <span className="mx-1.5 text-faint">→</span>
            {target}
          </>
        )}
      </div>
      <div
        role="status"
        data-tone={tone}
        className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground"
      >
        <span
          aria-hidden="true"
          data-dot
          className={cn("size-1.5 shrink-0", DOT[tone])}
        />
        <span className="min-w-0 break-words">{state}</span>
      </div>
      <div className="col-start-2 row-span-3 row-start-1 flex flex-col items-end gap-0.5">
        {actions}
        {meta !== undefined && (
          <span className="text-[11px] leading-4 text-faint">{meta}</span>
        )}
      </div>
    </section>
  );
}

/** Under the bar when something stands in the way: why, and what to do next. */
export function UpdateNotice({
  tone,
  children,
}: {
  tone: "warning" | "error" | "muted";
  children: ReactNode;
}) {
  return (
    <div
      data-tone={tone}
      className={cn(
        "mt-2 flex items-start gap-2 border px-2.5 py-1.5 text-xs leading-5 break-words",
        tone === "error"
          ? "border-state-error/45"
          : tone === "warning"
            ? "border-state-warning/45"
            : "border-border",
      )}
    >
      <WarningCircleIcon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          tone === "error"
            ? "text-state-error-ink"
            : tone === "warning"
              ? "text-state-warning-ink"
              : "text-muted-foreground",
        )}
      />
      <div className="min-w-0 space-y-0.5">{children}</div>
    </div>
  );
}

/** A step of a running update: done, the one under way, or still to come. */
export interface UpdateStep {
  key: string;
  label: string;
}

/** The steps as a thin strip, the current one marked; `failing` marks it as going wrong. */
export function UpdateSteps({
  steps,
  current,
  failing = false,
  children,
}: {
  steps: readonly UpdateStep[];
  current: number;
  failing?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="mt-2">
      <ol className="grid grid-cols-6 gap-1">
        {steps.map((step, index) => {
          const state =
            index < current ? "done" : index === current ? "current" : "todo";
          return (
            <li
              key={step.key}
              data-step={state}
              aria-current={state === "current" ? "step" : undefined}
              className={cn(
                "border-t-[3px] pt-1 text-[11px] leading-4",
                state === "done" &&
                  "border-state-success text-muted-foreground",
                state === "current" &&
                  (failing
                    ? "border-state-error text-foreground"
                    : "border-state-info text-foreground"),
                state === "todo" && "border-border text-faint",
              )}
            >
              {step.label}
            </li>
          );
        })}
      </ol>
      {children}
    </div>
  );
}

/** "What's new ▸" under the bar: folded to its first point, open to a few and the full page. */
export function ReleaseNotes({
  text,
  url,
}: {
  text: string;
  url: string | null;
}) {
  const { t: translateText } = useTranslation(["settings"] as const);
  const [open, setOpen] = useState(false);
  const items = noteItems(text);
  if (items.length === 0) return null;
  const Caret = open ? CaretDownIcon : CaretRightIcon;
  return (
    <div className="border border-t-0 border-border px-3 py-1.5 text-xs leading-5">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1.5 text-left text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(!open)}
      >
        <span className="shrink-0">{translateText("update.notes")}</span>
        <Caret aria-hidden="true" className="size-3 shrink-0" />
        {!open && (
          <span className="min-w-0 truncate text-faint">{items[0]}</span>
        )}
      </button>
      {open && (
        <div className="pb-0.5">
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          {url !== null && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {translateText("update.notesFull")}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/** A labelled group of rows in one thin box; `toggle` sits on the label's line, on the right. */
export function UpdateGroup({
  label,
  toggle,
  children,
}: {
  label: string;
  toggle?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section aria-label={label} className="mt-4">
      <div className="mb-1 flex items-center justify-between text-[11px] leading-4 text-muted-foreground">
        <h3 className="font-normal">{label}</h3>
        {toggle}
      </div>
      {children !== undefined && children !== false && (
        <div className="divide-y divide-border border border-border">
          {children}
        </div>
      )}
    </section>
  );
}

/** One row of a group: its name, what it is (with small words under), and a button. */
export function UpdateRow({
  label,
  labelId,
  value,
  hint,
  action,
}: {
  label: string;
  labelId?: string;
  value: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-2.5 px-2.5 py-1.5 text-xs leading-5">
      <span id={labelId} className="self-start pt-px text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0">
        <div className="break-words">{value}</div>
        {hint !== undefined && (
          <div className="text-[11px] leading-4 break-words text-faint">
            {hint}
          </div>
        )}
      </div>
      <div className="self-start">{action}</div>
    </div>
  );
}
