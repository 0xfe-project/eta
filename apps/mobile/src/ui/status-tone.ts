import type { BoardTaskStatus } from "@eta/client-contracts";

// A status's colours, as the web app has them: the mark and its words, a label's tint, a control's frame.

type Tone =
  | "foreground"
  | "muted-foreground"
  | `state-${"info" | "warning" | "success" | "error"}`;

export const TONES: Record<BoardTaskStatus, Tone> = {
  backlog: "muted-foreground",
  todo: "foreground",
  in_progress: "state-info",
  in_review: "state-warning",
  done: "state-success",
  blocked: "state-error",
  cancelled: "muted-foreground",
};

/** A label's tint, by status: the colour at a tenth or so. */
export const TINTS: Record<BoardTaskStatus, string> = {
  backlog: "bg-muted-foreground/10",
  todo: "bg-foreground/5",
  in_progress: "bg-state-info/10",
  in_review: "bg-state-warning/15",
  done: "bg-state-success/10",
  blocked: "bg-state-error/10",
  cancelled: "bg-muted-foreground/10",
};

export const statusTone = (status: BoardTaskStatus): Tone => TONES[status];

/** A status control's frame: the colour itself, or a softer grey for the uncoloured three. */
const BORDERS: Record<BoardTaskStatus, string> = {
  backlog: "border-muted-foreground/40",
  todo: "border-foreground/40",
  in_progress: "border-state-info",
  in_review: "border-state-warning",
  done: "border-state-success",
  blocked: "border-state-error",
  cancelled: "border-muted-foreground/40",
};

/** The classes of a control that is a status's label: frame, tint, and the words' colour. */
export const statusClasses = (status: BoardTaskStatus) => ({
  frame: `${BORDERS[status]} ${TINTS[status]}`,
  text: `text-${TONES[status]}`,
});
