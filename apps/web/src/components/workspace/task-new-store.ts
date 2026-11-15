import { create } from "zustand";

// Which new-task form is open, and what it opens with (`task-new.tsx`); anything on the tasks
// page opens it.

/** What the form opens with. */
export interface NewTaskPreset {
  parentId?: string | null;
  dependsOn?: { id: string; requireDone: boolean }[];
  split?: boolean;
}

interface NewTaskStore {
  /** Open with this preset; undefined is closed. A new object each opening, so the form starts over. */
  preset: NewTaskPreset | undefined;
  open: (preset?: NewTaskPreset) => void;
  close: () => void;
}

export const useNewTask = create<NewTaskStore>()((set) => ({
  preset: undefined,
  open: (preset = {}) => set({ preset: { ...preset } }),
  close: () => set({ preset: undefined }),
}));
