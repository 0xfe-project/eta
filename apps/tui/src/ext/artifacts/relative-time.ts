import type { Locale } from "../../config/types";
import { translatorFor } from "../../i18n/messages";
import { artifactMessages } from "./messages";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long before `now` the time `then` was, in whole minutes, hours or days: `3m ago`. */
export function relativeTime(
  then: number,
  now: number,
  locale: Locale,
): string {
  const t = translatorFor(artifactMessages, locale);
  const elapsed = now - then;
  if (elapsed < MINUTE) return t("justNow");
  if (elapsed < HOUR)
    return t("minutesAgo", { count: Math.floor(elapsed / MINUTE) });
  if (elapsed < DAY)
    return t("hoursAgo", { count: Math.floor(elapsed / HOUR) });
  return t("daysAgo", { count: Math.floor(elapsed / DAY) });
}
