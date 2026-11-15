import type { TaskStatus } from "@/queries/tasks";
import { useId } from "react";
import { cn } from "@/lib/utils";
import { statusLabel, statusTone } from "./task-format";

// A task's status, drawn. One set of shapes everywhere a status shows (the board, a task's page,
// the side panel, a chat's cards): the outlined three are work not finished yet, the four solid
// ones want the reader or are settled. Each takes its status's colour from the state tokens, which
// are a step lighter in the dark theme.

/** What a solid status cuts out of its disc, in a 16 box: drawn black into the disc's mask. */
const cutouts: Partial<Record<TaskStatus, React.ReactNode>> = {
  in_review: (
    <>
      <path d="M3.6 8C5.2 5.2 10.8 5.2 12.4 8 10.8 10.8 5.2 10.8 3.6 8Z" />
      <circle cx="8" cy="8" r="1.6" fill="white" />
    </>
  ),
  done: (
    <path
      d="M4.8 8.2 7 10.3 11.3 5.9"
      fill="none"
      stroke="black"
      strokeWidth="1.8"
      strokeLinecap="square"
    />
  ),
  blocked: <rect x="4.3" y="7" width="7.4" height="2" />,
  cancelled: (
    <path
      d="M5.5 5.5 10.5 10.5M10.5 5.5 5.5 10.5"
      stroke="black"
      strokeWidth="1.7"
    />
  ),
};

/** The outlined statuses: a ring, dashed for the backlog, half filled while it is worked on. */
function Ring({ status }: { status: TaskStatus }) {
  return (
    <>
      <circle
        cx="8"
        cy="8"
        r="6.2"
        fill="none"
        stroke="currentColor"
        strokeWidth={status === "backlog" ? 1.6 : 1.8}
        // Eight dashes all the way round, whatever the circumference rounds to.
        {...(status === "backlog"
          ? { pathLength: 36, strokeDasharray: "2.5 2" }
          : {})}
      />
      {status === "in_progress" ? (
        <path d="M8 3.3A4.7 4.7 0 0 1 8 12.7Z" fill="currentColor" />
      ) : null}
    </>
  );
}

export function StatusIcon({
  status,
  className,
}: {
  status: TaskStatus;
  className?: string;
}) {
  // The cut-outs are holes, not white paint: on a tinted label or a hovered row the background
  // shows through them, as it would through the old outlined icons.
  const mask = `status-${useId().replaceAll(/[^\w-]/g, "")}`;
  const cutout = cutouts[status];
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      data-status={status}
      className={cn("size-4 shrink-0", statusTone(status).text, className)}
    >
      {cutout === undefined ? (
        <Ring status={status} />
      ) : (
        <>
          <mask id={mask}>
            <rect width="16" height="16" fill="white" />
            <g fill="black">{cutout}</g>
          </mask>
          <circle
            cx="8"
            cy="8"
            r="7"
            fill="currentColor"
            mask={`url(#${mask})`}
          />
        </>
      )}
    </svg>
  );
}

/**
 * A status as a label: its mark and its name on a tint of its colour. Where a row already leads
 * with the mark, `icon={false}` leaves it out; `children` replaces the name ("In progress · 2/5").
 */
export function StatusPill({
  status,
  icon = true,
  className,
  children,
}: {
  status: TaskStatus;
  icon?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  const tone = statusTone(status);
  return (
    <span
      data-status={status}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 py-px pr-1.5 text-xs leading-5 whitespace-nowrap",
        icon ? "pl-1" : "pl-1.5",
        tone.tint,
        tone.text,
        className,
      )}
    >
      {icon ? <StatusIcon status={status} className="size-3" /> : null}
      {children ?? statusLabel(status)}
    </span>
  );
}
