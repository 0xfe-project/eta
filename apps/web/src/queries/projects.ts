import type {
  MachineView,
  ProjectArgs,
  ProjectResults,
  ProjectView,
} from "@eta/client-contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { getWire } from "@/lib/wire";
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

/**
 * The directories in a directory of a machine, with `path` left out for its home. Kept for a moment
 * so stepping back into a directory just left is instant; a failure says why in `problem.code`.
 */
export const directoriesQuery = (machineId: string, path: string | undefined) =>
  queryOptions({
    queryKey: ["directories", machineId, path ?? null],
    queryFn: () =>
      getWire().call<ProjectResults["directories"]>(
        "projects",
        "directories",
        { machineId, ...(path === undefined ? {} : { path }) },
        { timeoutMs: 20_000 },
      ),
    staleTime: 5_000,
    retry: false,
  });

const NO_FILES: readonly string[] = [];

/**
 * The project's files for the composer's `@` menu, listed on the project's own machine. Asked for
 * only once `wanted` (the person typed an `@`), and kept for half a minute so the next `@` is
 * instant. A project whose machine cannot answer has no files rather than an error in the menu.
 */
export function useProjectFiles(
  projectId: string | undefined,
  wanted: boolean,
): readonly string[] {
  const { data } = useQuery({
    queryKey: ["project-files", projectId],
    queryFn: () =>
      getWire().call<ProjectResults["files"]>(
        "projects",
        "files",
        { projectId },
        { timeoutMs: 20_000 },
      ),
    enabled: wanted && projectId !== undefined,
    staleTime: 30_000,
    retry: false,
  });
  return data?.files ?? NO_FILES;
}
