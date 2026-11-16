import type { TaskFilter } from "./task-plan";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// How the tasks page shows the board: as a board, a list or a plan, and which tasks. The filter
// is one for the three views, so switching between them keeps it; the view is remembered in the
// browser, the filter only while the page is open.

export const taskViews = ["board", "list", "plan"] as const;
export type TaskViewKind = (typeof taskViews)[number];

/** How the list groups its rows: by the parent each belongs to, by status, or not at all. */
export const listGroupings = ["parent", "status", "none"] as const;
export type ListGrouping = (typeof listGroupings)[number];

interface TaskViewStore {
  view: TaskViewKind;
  grouping: ListGrouping;
  filter: TaskFilter;
  setView: (view: TaskViewKind) => void;
  setGrouping: (grouping: ListGrouping) => void;
  setFilter: (change: Partial<TaskFilter>) => void;
}

export const emptyFilter: TaskFilter = { q: "", who: null, under: null };

const taskViewKey = "eta.tasks.view.v1";

export const useTaskView = create<TaskViewStore>()(
  persist(
    (set) => ({
      view: "board",
      grouping: "parent",
      filter: emptyFilter,
      setView: (view) => set({ view }),
      setGrouping: (grouping) => set({ grouping }),
      setFilter: (change) =>
        set((s) => ({ filter: { ...s.filter, ...change } })),
    }),
    {
      name: taskViewKey,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ view: s.view, grouping: s.grouping }),
      // A saved value this page does not know (an older or newer one) is the default.
      merge: (saved, current) => {
        const s = (saved ?? {}) as Partial<TaskViewStore>;
        return {
          ...current,
          view: taskViews.includes(s.view as TaskViewKind)
            ? (s.view as TaskViewKind)
            : current.view,
          grouping: listGroupings.includes(s.grouping as ListGrouping)
            ? (s.grouping as ListGrouping)
            : current.grouping,
        };
      },
    },
  ),
);
