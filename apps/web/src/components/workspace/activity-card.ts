// What the cards under a tool call share: their frame, the part that acts,
// and muted text.
export const frameClass =
  "flex min-h-11 max-w-md items-stretch border border-[var(--terminal-muted)]/40 sm:min-h-8";
export const actionClass =
  "flex min-w-0 items-center gap-2 px-2 py-1 text-left outline-none transition-colors duration-[60ms] ease-linear hover:bg-[var(--terminal-muted)]/10 focus-visible:ring-1 focus-visible:ring-[var(--terminal-link)]/60 motion-reduce:transition-none";
export const muted = "text-[var(--terminal-muted)]";
