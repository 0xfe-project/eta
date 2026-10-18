import type { MachineView, ProjectView } from "@eta/client-contracts";
import { useCreateProject, useMachines, useProjects } from "@/queries/projects";

/**
 * Where a conversation works: one of the projects, or a path to add as one.
 *
 * `projectId` undefined means "the first project"; `""` means "add a path", which is also all there
 * is to choose from while there are no projects. A path is added on `machineId` (undefined means
 * the primary), and adding one that is already a project is the same as choosing it.
 */
export interface ProjectChoice {
  projectId: string | undefined;
  path: string;
  machineId?: string;
}

/** The machines a path can be added on: the primary and the online ones that are let in. */
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

/** The project the choice names, if it names one that exists. */
export function useChosenProject(choice: ProjectChoice): {
  project: ProjectView | undefined;
  adding: boolean;
} {
  const projects = useChoosable();
  const adding = choice.projectId === "" || projects.length === 0;
  return {
    adding,
    project: adding
      ? undefined
      : (projects.find((p) => p.id === choice.projectId) ?? projects[0]),
  };
}

/** The project the choice stands for, adding the path first when that is what it is. */
export function useResolveProject() {
  const create = useCreateProject();
  return {
    pending: create.isPending,
    resolve: async (
      choice: ProjectChoice,
      project: ProjectView | undefined,
      stewardId: string | null,
    ): Promise<ProjectView> =>
      project ??
      (
        await create.mutateAsync({
          path: choice.path.trim(),
          ...(choice.machineId === undefined
            ? {}
            : { machineId: choice.machineId }),
          ...(stewardId === null ? {} : { stewardId }),
        })
      ).project,
  };
}
