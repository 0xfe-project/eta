import type { MachineView, ProjectView } from "@eta/client-contracts";
import { useMachines, useProjects } from "@/queries/projects";
import { useWorkspaceStore } from "./workspace-store";

/** The machines a directory can be chosen on: the primary and the online ones that are let in. */
export function useUsableMachines(): MachineView[] {
  const { machines } = useMachines();
  return machines.filter((machine) => machine.status === "online");
}

/** The projects a conversation can be started in: not an agent's own workspace, not put away. */
export function useChoosable(): ProjectView[] {
  const { projects } = useProjects();
  return projects.filter(
    (project) => project.kind === "project" && !project.archived,
  );
}

/** How many started-in directories each machine remembers, to put its projects in order. */
const RECENT_DIRECTORIES = 5;

export function rememberDirectory(machineId: string, path: string) {
  useWorkspaceStore.getState().setWorkspace((workspace) => {
    const earlier = workspace.recentDirectories?.[machineId] ?? [];
    return {
      ...workspace,
      recentDirectories: {
        ...workspace.recentDirectories,
        [machineId]: [path, ...earlier.filter((seen) => seen !== path)].slice(
          0,
          RECENT_DIRECTORIES,
        ),
      },
    };
  });
}
