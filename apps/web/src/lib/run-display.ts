import { translate } from "./i18n";

// How a run's timing is shown outside the pure arithmetic of `run-timing.ts`: a whole run's length
// in words, and sending a log to the step that was picked.

/** How long a whole run took, in words: "42 秒", "4 分 08 秒", "1 小时 02 分". */
export function longDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const pad = (value: number) => String(value).padStart(2, "0");
  if (total < 60)
    return translate("common:time.durationSeconds", { seconds: total });
  if (total < 3600)
    return translate("common:time.durationMinutesSeconds", {
      minutes: Math.floor(total / 60),
      seconds: pad(total % 60),
    });
  return translate("common:time.durationHoursMinutes", {
    hours: Math.floor(total / 3600),
    minutes: pad(Math.floor((total % 3600) / 60)),
  });
}

/**
 * Send a log to a step: the first of its blocks the log draws (a call folded into a group opens
 * it), scrolled to and marked until another is picked. False when the log draws none of them.
 */
export function revealBlock(
  box: HTMLElement | null,
  ids: readonly string[],
): boolean {
  if (box === null) return false;
  const escape = (id: string) =>
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(id)
      : id.replace(/["\\]/g, "\\$&");
  for (const id of ids) {
    const target = box.querySelector<HTMLElement>(
      `[data-block="${escape(id)}"]`,
    );
    if (target === null) continue;
    for (
      let up = target.parentElement;
      up !== null && up !== box;
      up = up.parentElement
    )
      if (up instanceof HTMLDetailsElement) up.open = true;
    for (const marked of box.querySelectorAll("[data-hit]"))
      marked.removeAttribute("data-hit");
    target.setAttribute("data-hit", "");
    target.scrollIntoView?.({ block: "center" });
    return true;
  }
  return false;
}
