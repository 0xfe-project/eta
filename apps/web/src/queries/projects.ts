import type {
  MachineView,
  ProjectArgs,
  ProjectResults,
  ProjectView,
} from "@eta/client-contracts";
import { useListTarget, useWireMutation } from "@/queries/wire";

// Projects and the machines they live on: a project is `machine + absolute path` with a steward
// (the agent a message that names nobody goes to).

export function useMachines() {
  const { items, loaded, error } = useListTarget<MachineView>("machines");
  return { machines: items, loaded, error };
}

export function useProjects() {
  const { items, loaded, error } = useListTarget<ProjectView>("projects");
  return { projects: items, loaded, error };
}

/** Adding a path that is already a project returns that project (`existed`), so asking is safe. */
export function useCreateProject() {
  return useWireMutation<ProjectArgs["create"], ProjectResults["create"]>(
    "projects",
    "create",
  );
}

export function useSetProjectSteward() {
  return useWireMutation<
    ProjectArgs["setSteward"],
    ProjectResults["setSteward"]
  >("projects", "setSteward");
}
