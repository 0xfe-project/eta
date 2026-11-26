import { context, signal, Storage } from "nsh";

// Settings › Appearance › Process detail, kept on this device. Brief: a reply's process is its
// "Process · N steps" row alone. Standard: the row and its steps. Detailed: the steps with
// thoughts open; a thought the reader folds stays folded.

export type ProcessDetail = "brief" | "standard" | "detailed";

export const processDetails = ["brief", "standard", "detailed"] as const;

const storageKey = "eta.messages.process";

export function createProcessDetail() {
  const detail = signal<ProcessDetail>("standard");
  let changed = false;
  void Storage.getItem(storageKey)
    .then((stored) => {
      if (
        !changed &&
        (stored === "brief" || stored === "standard" || stored === "detailed")
      )
        detail.set(stored);
    })
    .catch(() => {});
  return {
    detail: () => detail(),
    set(next: ProcessDetail) {
      changed = true;
      detail.set(next);
      void Storage.setItem(storageKey, next).catch(() => {});
    },
  };
}

/** How much of a reply's process shows on this device; standard where nothing provides it. */
export const ProcessDetails = context<ReturnType<typeof createProcessDetail>>({
  detail: () => "standard",
  set: () => {},
});
