/** What the pending entry and its layers read off the wire, re-rendering only when it changes. */

import type { WireState } from "../../connection/types";
import type { PendingItem } from "./model";
import { useMemo } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useShell } from "../../extensions/react";
import { pendingItems } from "./model";

/**
 * The targets a computation reads, picked one by one so the result is computed again only when
 * one of them changes.
 */
function useTargets(names: readonly string[]): Pick<WireState, "targets"> {
  const { wire } = useShell();
  const picked = useStore(
    wire.store,
    useShallow((state) => names.map((name) => state.targets[name])),
  );
  return useMemo(() => {
    const targets: WireState["targets"] = {};
    names.forEach((name, index) => {
      const target = picked[index];
      if (target !== undefined) targets[name] = target;
    });
    return { targets };
  }, [names, picked]);
}

const PENDING_TARGETS = ["inbox", "tasks"] as const;
const PANEL_TARGETS = ["inbox", "tasks", "agents", "conversations"] as const;

/** Everything waiting, oldest first. */
export function usePendingItems(): PendingItem[] {
  const state = useTargets(PENDING_TARGETS);
  return useMemo(() => pendingItems(state), [state]);
}

/** The lists the panel and the item layers draw from. */
export function usePanelState(): Pick<WireState, "targets"> {
  return useTargets(PANEL_TARGETS);
}

/** A task's own target, with its details and activity once they come. */
export function useTaskTarget(taskId: string): Pick<WireState, "targets"> {
  return useTargets(useMemo(() => [`tasks.${taskId}`], [taskId]));
}
