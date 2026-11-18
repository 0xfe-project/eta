import type { KeyboardEvent } from "react";

/** Up and down walk the buttons of a list; a filter box hands over to the first one. */
export function moveRow(event: KeyboardEvent, list: HTMLElement | null) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = [...(list?.querySelectorAll<HTMLElement>("button") ?? [])];
  const at = rows.indexOf(document.activeElement as HTMLElement);
  const next = rows[event.key === "ArrowDown" ? at + 1 : Math.max(at - 1, 0)];
  if (next === undefined) return;
  event.preventDefault();
  next.focus();
}
