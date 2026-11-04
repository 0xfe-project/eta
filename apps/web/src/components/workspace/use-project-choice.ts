import type { MachineView, ProjectView } from "@eta/client-contracts";
import type { DirectoryPickerProps } from "./directory-picker";
import { useEffect, useRef, useState } from "react";
import { useCreateProject, useMachines, useProjects } from "@/queries/projects";
import { useWorkspaceStore } from "./workspace-store";

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

/** How many chosen directories each machine remembers: the list on top of its home. */
const RECENT_DIRECTORIES = 5;

function rememberDirectory(machineId: string, path: string) {
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

/**
 * A dialog whose project field can swap the form for the directory picker. The form's state stays
 * where it is, in the dialog, and only what is on screen changes: going back finds it as it was.
 * Escape and a click outside step back too, rather than close a form that is half filled in.
 *
 * A directory that is already a project is that project. One that was put away, or is an agent's
 * own, is not in the list to choose from, so it stays a path and adding it finds the project.
 */
export function useDirectoryBrowsing(
  choice: ProjectChoice,
  onChange: (choice: ProjectChoice) => void,
) {
  const projects = useChoosable();
  const { machines } = useMachines();
  const primary = machines.find((machine) => machine.kind === "primary");
  const [machineId, setMachineId] = useState<string | undefined>(undefined);
  const browsing = machineId !== undefined;
  const wasBrowsingRef = useRef(false);
  useEffect(() => {
    // Back on the form, the keyboard is back on the field that left it.
    if (wasBrowsingRef.current && !browsing)
      document.getElementById("new-project")?.focus();
    wasBrowsingRef.current = browsing;
  }, [browsing]);

  const back = () => setMachineId(undefined);
  const dialog = {
    className: browsing ? "sm:max-w-[560px]" : undefined,
    onEscapeKeyDown: (event: KeyboardEvent) => {
      if (browsing) event.preventDefault();
    },
    onInteractOutside: (event: Event) => {
      if (browsing) event.preventDefault();
    },
    onKeyDown: (event: { key: string; nativeEvent: KeyboardEvent }) => {
      if (browsing && event.key === "Escape" && !event.nativeEvent.isComposing)
        back();
    },
  };
  const chosenOn = choice.machineId ?? primary?.id;
  const picker: DirectoryPickerProps = {
    machineId: machineId ?? "",
    start:
      choice.path.trim() !== "" && chosenOn === machineId
        ? choice.path.trim()
        : undefined,
    onBack: back,
    onPick: (path, on) => {
      rememberDirectory(on, path);
      const existing = projects.find(
        (project) => project.machineId === on && project.path === path,
      );
      onChange({
        projectId: existing?.id ?? "",
        path: existing === undefined ? path : "",
        machineId: on,
      });
      back();
    },
  };
  return {
    browsing,
    picker,
    dialog,
    /** Open on a machine; none is where the choice already points. */
    browse: (on?: string) => setMachineId(on ?? chosenOn ?? ""),
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
