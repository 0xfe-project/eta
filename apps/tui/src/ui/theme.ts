/** The Ink colour for a theme value; `default` means the terminal's own colour, so no colour at all. */
export function inkColor(value: string): string | undefined {
  return value === "default" ? undefined : value;
}
