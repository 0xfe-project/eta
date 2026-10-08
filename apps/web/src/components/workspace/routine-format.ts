import type { Schedule } from "@/queries/routines";

// How routines read: their schedules and their times.

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export function describeSchedule(schedule: Schedule) {
  switch (schedule.kind) {
    case "daily":
      return `每天 ${schedule.time}`;
    case "weekly":
      return `每周${schedule.days.map((d) => WEEKDAYS[d]).join("、")} ${schedule.time}`;
    case "hourly":
      return schedule.every === 1 ? "每小时" : `每 ${schedule.every} 小时`;
    case "cron":
      return `cron ${schedule.cron}`;
  }
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** "今天 08:02", "明天 08:00", "10-11 08:03". */
export function when(iso: string) {
  const date = new Date(iso);
  const time = date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const days = Math.round(
    (startOfDay(date).getTime() - startOfDay(new Date()).getTime()) /
      86_400_000,
  );
  const label =
    { [-1]: "昨天", 0: "今天", 1: "明天" }[days] ??
    `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, "0")}`;
  return `${label} ${time}`;
}

/**
 * When the schedule fires in [from, to), in this browser's time zone; none
 * for cron, which only the server evaluates.
 */
export function occurrences(schedule: Schedule, from: Date, to: Date) {
  const times: Date[] = [];
  if (schedule.kind === "cron") return times;
  const [y, m, d] = [from.getFullYear(), from.getMonth(), from.getDate()];
  const [hh, mm] =
    schedule.kind === "hourly" ? [0, 0] : schedule.time.split(":").map(Number);
  for (let i = 0; ; i++) {
    const time =
      schedule.kind === "hourly"
        ? new Date(y, m, d, from.getHours() + i)
        : new Date(y, m, d + i, hh, mm);
    if (time >= to) return times;
    if (time < from) continue;
    if (
      schedule.kind === "hourly"
        ? time.getHours() % schedule.every === 0
        : schedule.kind === "daily" || schedule.days.includes(time.getDay())
    )
      times.push(time);
  }
}
