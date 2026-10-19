/**
 * The `usage` plugin: what the models were used for, and by whom.
 *
 * One target, read-only. The generations are counted where the model layer reports them (see
 * `recorder.ts` and the product's `generated`); this publishes the sums as sections. A sum is a
 * read of the table, so a section is never out of step with it; a generation that ended only has
 * to say that the target moved.
 */
import type { UsageStore } from "./store";
import { productPlugin, publish } from "../wire";

export function usagePlugin(usage: UsageStore, applied: () => void) {
  return productPlugin(
    "usage",
    ({ wire }) =>
      publish(wire, "usage", {
        agents: () => usage.agents(),
        routines: () => usage.routines(),
        models: () => usage.models(),
        days: () => usage.days(),
      }),
    applied,
  );
}
