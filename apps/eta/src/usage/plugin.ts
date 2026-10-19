/**
 * The `usage` plugin: what the models were used for, and by whom.
 *
 * One target, read-only. It counts the generations of every session the host opens (`recorder.ts`)
 * and publishes the sums as sections. A sum is a read of the table, so a section is never
 * out of step with it; a generation that ended only has to say that the target moved.
 */
import type { UsageStore } from "./store";
import { productPlugin, publish } from "../wire";
import { recordGenerations } from "./recorder";

export interface UsagePluginDeps {
  usage: UsageStore;
  warn: (message: string) => void;
}

export function usagePlugin(deps: UsagePluginDeps, applied: () => void) {
  const { usage, warn } = deps;
  return productPlugin(
    "usage",
    ({ wire, sessions }) => {
      const stop = recordGenerations(
        sessions,
        usage,
        // Run traffic, not a click: the paced push, so a busy agent costs a bounded number of frames.
        () => wire.push("usage"),
        warn,
      );
      const off = publish(wire, "usage", {
        agents: () => usage.agents(),
        models: () => usage.models(),
        days: () => usage.days(),
      });
      return () => {
        stop();
        off();
      };
    },
    applied,
  );
}
