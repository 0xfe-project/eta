/** Keys the lists use that `KEYS` in `test/ui-support/render.tsx` does not have. */
export const LIST_KEYS = {
  pageUp: "\u001B[5~",
  pageDown: "\u001B[6~",
  home: "\u001B[H",
  end: "\u001B[F",
  space: " ",
} as const;
