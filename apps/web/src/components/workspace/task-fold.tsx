import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";

// The fold a row of a conversation's timeline is drawn in when it is worth reading only once opened:
// a task draft, a task card, a proposal of Captain's. One line with a chevron, opened in place, the way
// a turn's thinking and its tool calls are; the choice is remembered by the row (see `lib/fold.ts`).

/**
 * The line a folded task row leaves on the page: chevron, what it is, what it proposes, what it
 * waits on, and the way to act on it.
 *
 * A control standing on the line — the way to the form, the way to the task — is the line's other
 * purpose, and its click is spent there: it should not also fold the card around the reader's
 * fingers. That has to be said on the way into the line rather than on the way out of it, because the
 * browser begins its toggling as soon as the click has passed the line, and by the time the control's
 * own handler hears about the click the decision is already made.
 */
export function TaskFoldHead({
  icon: Icon = ListChecksIcon,
  label,
  title,
  marker,
  children,
}: {
  /** What kind of row it is, beside its label. A task's by default. */
  icon?: PhosphorIcon;
  label: string;
  /**
   * The one line the row is about: a proposed title, or a task's number and title — as a link when
   * there is somewhere for it to go, since this line is the card while it is folded.
   */
  title: React.ReactNode;
  /** What the reader owes this row, said quietly at the right end of the line. */
  marker?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <summary
      className="thinking-block-header task-fold-head"
      onClickCapture={(event) => {
        const target = event.target as Element;
        if (target.closest("button,a") !== null) event.preventDefault();
      }}
    >
      <span aria-hidden="true" className="thinking-block-chevron">
        ▶
      </span>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="shrink-0">{label}</span>
      <span className="task-fold-title">{title}</span>
      {marker}
      {children}
    </summary>
  );
}
