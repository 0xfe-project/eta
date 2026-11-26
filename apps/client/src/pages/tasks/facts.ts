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
 * "Running 1 min": since its executor's run started. A mentioned agent answering is not the task
 * running, so its run does not restart the clock. A host older than `runStartedAt` only says when
 * the task last moved, which a run's start does (and a comment during the run, too).
 */
export function runningFor(task: BoardTaskView) {
  const since = task.runStartedAt ?? task.updatedAt;
  const minutes = Math.max(
    1,
    Math.floor(Math.abs(Date.now() - since) / 60_000),
  );
  return uiText("taskRunningFor", {
    time:
      minutes < 60
        ? uiText("taskMinutes", { count: minutes })
        : uiText("taskHours", { count: Math.floor(minutes / 60) }),
  });
}

/**
 * An index built once per task list and kept while that list is the one in use: the host sends a
 * new array whenever the board changes, so the same array always means the same tasks.
 */
function perList<T>(build: (tasks: BoardTaskView[]) => T) {
  const built = new WeakMap<BoardTaskView[], T>();
  return (tasks: BoardTaskView[]) => {
    let index = built.get(tasks);
    if (index === undefined) {
      index = build(tasks);
      built.set(tasks, index);
    }
    return index;
  };
}

const waitingOn = perList((tasks) => {
  const dependents = new Map<string, BoardTaskView[]>();
  for (const other of tasks) {
    if (other.status === "done" || other.status === "cancelled") continue;
    for (const id of new Set(other.dependsOn?.map((edge) => edge.taskId))) {
      const list = dependents.get(id);
      if (list) list.push(other);
      else dependents.set(id, [other]);
    }
  }
  return dependents;
});

/** The tasks that wait for this one and are not over. */
export function dependentsOf(task: BoardTaskView, tasks: BoardTaskView[]) {
  return waitingOn(tasks).get(task.id) ?? [];
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

const stepsByParent = perList((tasks) => {
  const siblings = new Map<string, BoardTaskView[]>();
  for (const task of tasks) {
    if (!task.parentId) continue;
    const group = siblings.get(task.parentId);
    if (group) group.push(task);
    else siblings.set(task.parentId, [task]);
  }
  const steps = new Map<string, number>();
  for (const group of siblings.values())
    for (const [id, level] of planLevels(group).levels)
      steps.set(id, level + 1);
  return steps;
});

/** A subtask's step in its parent's plan, from 1; undefined for a task without a parent. */
export function stepOf(task: BoardTaskView, tasks: BoardTaskView[]) {
  if (!task.parentId) return undefined;
  return stepsByParent(tasks).get(task.id) ?? 1;
}

export interface StandalonePlanChain {
  key: string;
  terminal: BoardTaskView;
  tasks: BoardTaskView[];
  active: boolean;
}

/**
 * Top-level (non-parent, non-subtask-of-present-parent) non-cancelled tasks connected via
 * `dependsOn` edges, grouped into connected components of size >= 2 and split into active vs.
 * all-done chains (each sorted newest-first by highest task number).
 */
export function standaloneDependencyChains(
  items: BoardTaskView[],
  parentIds: ReadonlySet<string> = new Set(),
): {
  active: StandalonePlanChain[];
  completed: StandalonePlanChain[];
} {
  const itemIds = new Set(items.map((task) => task.id));
  const standalone = items.filter(
    (task) =>
      task.status !== "cancelled" &&
      !parentIds.has(task.id) &&
      !(task.parentId && itemIds.has(task.parentId)),
  );
  const byId = new Map(standalone.map((task) => [task.id, task]));
  const neighbors = new Map<string, Set<string>>();
  for (const task of standalone) neighbors.set(task.id, new Set());
  for (const task of standalone) {
    for (const edge of task.dependsOn ?? []) {
      if (edge.taskId === task.id || !byId.has(edge.taskId)) continue;
      neighbors.get(task.id)!.add(edge.taskId);
      neighbors.get(edge.taskId)!.add(task.id);
    }
  }

  const visited = new Set<string>();
  const active: StandalonePlanChain[] = [];
  const completed: StandalonePlanChain[] = [];

  for (const root of standalone) {
    if (visited.has(root.id)) continue;
    const queue = [root.id];
    visited.add(root.id);
    const component: BoardTaskView[] = [];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]!;
      const task = byId.get(id);
      if (task) component.push(task);
      for (const next of neighbors.get(id) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    if (component.length < 2) continue;

    component.sort((a, b) => a.number - b.number || a.id.localeCompare(b.id));
    const { levels } = planLevels(component);
    let terminal = component[0]!;
    let bestLevel = -1;
    for (const task of component) {
      const level = levels.get(task.id) ?? 0;
      if (
        level > bestLevel ||
        (level === bestLevel && task.number >= terminal.number)
      ) {
        bestLevel = level;
        terminal = task;
      }
    }
    const isActive = component.some(
      (task) => task.status !== "done" && task.status !== "cancelled",
    );
    const chain: StandalonePlanChain = {
      key: terminal.id,
      terminal,
      tasks: component,
      active: isActive,
    };
    if (isActive) active.push(chain);
    else completed.push(chain);
  }

  const byNewest = (a: StandalonePlanChain, b: StandalonePlanChain) => {
    const maxA = Math.max(...a.tasks.map((task) => task.number));
    const maxB = Math.max(...b.tasks.map((task) => task.number));
    return maxB - maxA || a.key.localeCompare(b.key);
  };
  active.sort(byNewest);
  completed.sort(byNewest);
  return { active, completed };
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

/** When something happened, on a phone task page: "26 minutes ago" within the hour, then "Today 10:20 PM", "Yesterday 11:55 PM" or the day. */
export function taskWhen(at: number) {
  const minutes = Math.floor(Math.max(0, Date.now() - at) / 60_000);
  if (minutes < 1) return uiText("taskJustNow");
  if (minutes < 60)
    return uiText(minutes === 1 ? "taskMinuteAgo" : "taskMinutesAgo", {
      count: minutes,
    });
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return new Date(at).toDateString() === yesterday.toDateString()
    ? uiText("taskYesterday", { time: clock(at) })
    : taskMoment(at);
}
