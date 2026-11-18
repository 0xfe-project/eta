// Where a conversation works: one of the projects, or a path to add as one. As the web's
// use-project-choice: `projectId` undefined is the first project, "" is adding `path` on
// `machineId` (undefined is the primary), and adding a path that is a project finds that project.

import type {
  MachineView,
  ProjectResults,
  ProjectView,
} from "@eta/client-contracts";
import { signal } from "nsh";
import { machineById, machines, projects } from "../../app/lists";
import { nav, open } from "../../nav/stack";
import { call } from "../../wire/target";
import { PlacePicker } from "./PlacePicker";
import { importRecentDirectories } from "./remember";

export interface ProjectChoice {
  projectId: string | undefined;
  path: string;
  /** The path as its machine writes it (`~/Developer/eta`), from the machine. */
  display: string;
  machineId?: string;
}

export const primaryMachine = (): MachineView | undefined =>
  machines().find((machine) => machine.kind === "primary");

/** The projects a conversation can start in: not an agent's own workspace, not put away. */
export const choosableProjects = (): ProjectView[] =>
  projects().filter(
    (project) => project.kind === "project" && !project.archived,
  );

/** `mac-studio · ~/Developer/eta`: the path as its machine writes it, which the host says. */
export function placeLine(place: {
  machineId: string;
  display: string;
}): string {
  const machine = machineById(place.machineId);
  return machine === undefined
    ? place.display
    : `${machine.name} · ${place.display}`;
}

/** The choice's state, and the way to the directory picker and back. */
export function useProjectChoice() {
  const choice = signal<ProjectChoice>({
    projectId: undefined,
    path: "",
    display: "",
  });
  // What this phone kept of recent directories before the host did goes to the host.
  void importRecentDirectories();
  const adding = () =>
    choice().projectId === "" || choosableProjects().length === 0;
  const project = (): ProjectView | undefined => {
    if (adding()) return undefined;
    const list = choosableProjects();
    return list.find((each) => each.id === choice().projectId) ?? list[0];
  };
  const chosenPlace = () => {
    const { machineId, path, display } = choice();
    return {
      machineId: machineId ?? primaryMachine()?.id ?? "",
      path: path.trim(),
      display,
    };
  };
  const browse = () => {
    open("new:directory", () => (
      <PlacePicker
        onPick={(picked) => {
          const existing = choosableProjects().find(
            (each) =>
              each.machineId === picked.machineId && each.path === picked.path,
          );
          choice.set({
            projectId: existing?.id ?? "",
            path: existing === undefined ? picked.path : "",
            display: existing === undefined ? picked.display : "",
            machineId: picked.machineId,
          });
          nav.pop();
        }}
      />
    ));
  };
  /** Nothing to start in yet: Add directory has not been through. */
  const missing = () => adding() && choice().path.trim() === "";
  /** The project the choice stands for, adding the path first when that is what it is. */
  const resolve = async (): Promise<ProjectView> => {
    const found = project();
    if (found !== undefined) {
      // Used now: first among the recent places, for every client (making one already is).
      void call("places", "remember", {
        machineId: found.machineId,
        path: found.path,
      }).catch(() => undefined);
      return found;
    }
    const { path, machineId } = choice();
    const { project: made } = await call<ProjectResults["create"]>(
      "projects",
      "create",
      {
        path: path.trim(),
        ...(machineId === undefined ? {} : { machineId }),
      },
    );
    return made;
  };
  return { choice, adding, project, chosenPlace, browse, missing, resolve };
}
