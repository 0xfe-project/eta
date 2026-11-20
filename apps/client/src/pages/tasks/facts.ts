import type { BoardTaskView } from "@eta/client-contracts";
import { uiText } from "../../i18n";
import { clock } from "../../services/host";

/** When a task last moved, said in full: "6 minutes ago", or the day (11-17) once a day has passed or it is over. */
export function taskTime(task: BoardTaskView) {
  const minutes = Math.floor(Math.abs(Date.now() - task.updatedAt) / 60_000);
  if (task.status === "done" || task.status === "cancelled" || minutes >= 1440)
    return taskDay(task.updatedAt);
  if (minutes < 1) return uiText("taskJustNow");
  if (minutes < 60)
    return uiText(minutes === 1 ? "taskMinuteAgo" : "taskMinutesAgo", {
      count: minutes,
    });
  const hours = Math.floor(minutes / 60);
  return uiText(hours === 1 ? "taskHourAgo" : "taskHoursAgo", {
    count: hours,
  });
}

export function taskDay(at: number) {
  const date = new Date(at);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * "Running 1 min". The board only knows when the task last moved, which a run's start does; a
 * comment during the run moves it too.
 */
export function runningFor(task: BoardTaskView) {
  const minutes = Math.max(
    1,
    Math.floor(Math.abs(Date.now() - task.updatedAt) / 60_000),
  );
  return uiText("taskRunningFor", {
    time:
      minutes < 60
        ? uiText("taskMinutes", { count: minutes })
        : uiText("taskHours", { count: Math.floor(minutes / 60) }),
  });
}

/** The tasks that wait for this one and are not over. */
export function dependentsOf(task: BoardTaskView, tasks: BoardTaskView[]) {
  return tasks.filter(
    (other) =>
      other.status !== "done" &&
      other.status !== "cancelled" &&
      other.dependsOn?.some((edge) => edge.taskId === task.id),
  );
}

export function isWaiting(task: BoardTaskView) {
  return task.status === "todo" && !!task.waitingOn?.length;
}

/**
 * Each task's step among its siblings: one after the furthest task it waits for. The plan draws
 * one column per step; a cycle is cut where it closes.
 */
export function planLevels(
  tasks: { id: string; dependsOn?: { taskId: string }[] }[],
) {
  const ids = new Set(tasks.map((task) => task.id));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const levels = new Map<string, number>();
  const parents = new Map<string, string>();
  const inStack = new Set<string>();
  function level(id: string): number {
    const known = levels.get(id);
    if (known !== undefined) return known;
    if (inStack.has(id)) return 0;
    inStack.add(id);
    let next = 0;
    for (const edge of byId.get(id)?.dependsOn ?? []) {
      if (!ids.has(edge.taskId)) continue;
      const depth = level(edge.taskId) + 1;
      if (depth > next) {
        next = depth;
        parents.set(id, edge.taskId);
      }
    }
    inStack.delete(id);
    levels.set(id, next);
    return next;
  }
  for (const task of tasks) level(task.id);
  return { levels, parents };
}

/** A subtask's step in its parent's plan, from 1; undefined for a task without a parent. */
export function stepOf(task: BoardTaskView, tasks: BoardTaskView[]) {
  if (!task.parentId) return undefined;
  const siblings = tasks.filter((other) => other.parentId === task.parentId);
  return (planLevels(siblings).levels.get(task.id) ?? 0) + 1;
}

/** What a list row or a plan card says of a task after its number. */
export function taskHint(task: BoardTaskView, tasks: BoardTaskView[]) {
  const cancelled = task.waitingOn?.find((edge) => edge.state === "cancelled");
  if (task.status === "blocked" && cancelled)
    return uiText("prerequisiteCancelled", { title: cancelled.title });
  const wait = task.waitingOn?.[0];
  if (isWaiting(task) && wait)
    return uiText("waitsForTask", { title: wait.title });
  if (task.status === "in_review") {
    const dependents = dependentsOf(task, tasks).length;
    return dependents
      ? `${uiText("forYouToCheck2")} · ${uiText("taskLetGo", { count: dependents })}`
      : uiText("forYouToCheck2");
  }
  if (task.status === "in_progress" && !task.subtasks?.total)
    return runningFor(task);
  if (task.status === "cancelled") return uiText("taskDropped");
  return undefined;
}

/** An exact moment: "Today 11:55 PM", or "11-17 9:02 AM" on another day. */
export function taskMoment(at: number) {
  const date = new Date(at);
  return date.toDateString() === new Date().toDateString()
    ? uiText("taskToday", { time: clock(at) })
    : `${taskDay(at)} ${clock(at)}`;
}
