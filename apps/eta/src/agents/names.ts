/** A name as it is compared: trimmed, and case does not matter. */
export const foldName = (name: string): string => name.trim().toLowerCase();

/** Whether two names denote the same agent. */
export const sameName = (a: string, b: string): boolean =>
  foldName(a) === foldName(b);
