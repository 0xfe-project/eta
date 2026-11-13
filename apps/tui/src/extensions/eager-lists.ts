/** The eager lists the host sends with hello, as the wire holds them; empty before they arrive. */
import type {
  AgentView,
  MachineView,
  ProjectView,
} from "@eta/client-contracts";
import type { WireState } from "../connection/types";

/** One empty list for every missing one, so a store selector returns the same value each time. */
const NONE: readonly never[] = Object.freeze([]);

function eagerList<T>(state: WireState, target: string): readonly T[] {
  return (state.targets[target]?.sections.list as T[] | undefined) ?? NONE;
}

export const agentsOf = (state: WireState) =>
  eagerList<AgentView>(state, "agents");
export const projectsOf = (state: WireState) =>
  eagerList<ProjectView>(state, "projects");
export const machinesOf = (state: WireState) =>
  eagerList<MachineView>(state, "machines");
