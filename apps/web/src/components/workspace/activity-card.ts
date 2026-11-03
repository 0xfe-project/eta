// What the cards under a tool call share: their frame, the part that acts,
// and muted text.
//
// The frame is as wide as the column it is drawn in — the sidebar's context
// sections, a turn's card column, a group's tab — and caps itself to nothing:
// the panel that holds it is what decides the width, so a card that capped
// itself stopped growing the moment you dragged the panel wider. `w-full` is
// spelled out because the frame is the frame of an `<a>` as often as of a
// `<div>`, and an anchor sitting in a flex row does not fill it on its own.
//
// It is told apart from the column by its fill, not a frame: the rails already draw their own
// lines between regions, and a card in a ruled box on top of those made every list a grid.
export const frameClass =
  "flex min-h-11 w-full items-stretch bg-card-raised sm:min-h-8";
export const actionClass =
  "flex min-w-0 items-center gap-2 px-2 py-1 text-left outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none";
export const muted = "text-muted-foreground";
