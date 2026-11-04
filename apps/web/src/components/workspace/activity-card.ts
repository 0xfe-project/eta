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
// It draws no box of its own, neither a frame nor a fill: a list of them is rows, and the list
// draws one rule between rows, edge to edge. A frame round every card on top of the rails' own
// lines made every list a grid.
export const frameClass = "flex min-h-11 w-full items-stretch sm:min-h-8";
// In a chat there is no list to draw the rules: a card stands alone among the turn's text, so it
// draws its own line. Cards that stack keep the column's gap between them, one line each.
export const framedClass = "border border-border";
export const actionClass =
  "flex min-w-0 items-center gap-2 px-3 py-1 text-left outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none";
export const muted = "text-muted-foreground";
