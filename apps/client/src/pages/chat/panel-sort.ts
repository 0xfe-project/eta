import { signal, Storage } from "nsh";

/** How the Tasks tab lists tasks: by what they need from you, or by when they last changed. */
export type TaskPanelSort = "needs" | "updated";

/**
 * The Tasks tab's sort, kept on this device and shared by every group (and by both scopes, this
 * group and all groups), like the transcript's card folds: how a list is read is a habit of a
 * screen, not of a group.
 */
const key = "eta.tasks-panel-sort.v1";

const sort = signal<TaskPanelSort>("needs");
let loaded = false;
let chosen = false;

function load() {
  if (loaded) return;
  loaded = true;
  void Storage.getItem(key)
    .then((raw) => {
      // A choice made before storage answered is newer than what it held.
      if (!chosen && (raw === "needs" || raw === "updated")) sort.set(raw);
    })
    .catch(() => {});
}

export function taskPanelSort(): TaskPanelSort {
  load();
  return sort();
}

export function setTaskPanelSort(next: TaskPanelSort): void {
  load();
  chosen = true;
  sort.set(next);
  void Storage.setItem(key, next).catch(() => {});
}
