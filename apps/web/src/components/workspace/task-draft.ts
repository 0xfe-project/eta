import { create } from "zustand";

/**
 * What is being written in each task's comment box, so that other parts of
 * the task (handing an assisting agent's answer to the assignee) can add to
 * it. Not persisted.
 */
interface TaskDraftStore {
  drafts: Record<string, string>;
  setDraft: (
    task: string,
    update: string | ((draft: string) => string),
  ) => void;
}

export const useTaskDraft = create<TaskDraftStore>((set) => ({
  drafts: {},
  setDraft: (task, update) =>
    set((state) => ({
      drafts: {
        ...state.drafts,
        [task]:
          typeof update === "function"
            ? update(state.drafts[task] ?? "")
            : update,
      },
    })),
}));
