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
import { DirectoryPicker } from "./DirectoryPicker";
import { rememberDirectory } from "./remember";

export interface ProjectChoice {
  projectId: string | undefined;
  path: string;
  machineId?: string;
}

export const primaryMachine = (): MachineView | undefined =>
  machines().find((machine) => machine.kind === "primary");

export const usableMachines = (): MachineView[] =>
  machines().filter((machine) => machine.status === "online");

/** The projects a conversation can start in: not an agent's own workspace, not put away. */
export const choosableProjects = (): ProjectView[] =>
  projects().filter(
    (project) => project.kind === "project" && !project.archived,
  );

export function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed.length === 0) return path;
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name.length === 0 ? trimmed : name;
}

export function shortenPath(
  path: string,
  home: string | null | undefined,
): string {
  if (home === null || home === undefined) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`)
    ? `~/${path.slice(home.length + 1)}`
    : path;
}

/** `mac-studio · ~/Developer/eta`. */
export function placeLine(place: { machineId: string; path: string }): string {
  const machine = machineById(place.machineId);
  const path = shortenPath(place.path, machine?.home);
  return machine === undefined ? path : `${machine.name} · ${path}`;
}

/** The choice's state, and the way to the directory picker and back. */
export function useProjectChoice() {
  const choice = signal<ProjectChoice>({ projectId: undefined, path: "" });
  const adding = () =>
    choice().projectId === "" || choosableProjects().length === 0;
  const project = (): ProjectView | undefined => {
    if (adding()) return undefined;
    const list = choosableProjects();
    return list.find((each) => each.id === choice().projectId) ?? list[0];
  };
  const chosenPlace = () => {
    const { machineId, path } = choice();
    return {
      machineId: machineId ?? primaryMachine()?.id ?? "",
      path: path.trim(),
    };
  };
  const browse = () => {
    const { machineId, path } = chosenPlace();
    open("new:directory", () => (
      <DirectoryPicker
        machineId={machineId}
        start={path === "" ? undefined : path}
        onPick={(picked, on) => {
          rememberDirectory(on, picked);
          const existing = choosableProjects().find(
            (each) => each.machineId === on && each.path === picked,
          );
          choice.set({
            projectId: existing?.id ?? "",
            path: existing === undefined ? picked : "",
            machineId: on,
          });
          nav.pop();
        }}
      />
    ));
  };
  /** Nothing to start in yet: 添加目录 has not been through. */
  const missing = () => adding() && choice().path.trim() === "";
  /** The project the choice stands for, adding the path first when that is what it is. */
  const resolve = async (stewardId: string | null): Promise<ProjectView> => {
    const found = project();
    if (found !== undefined) return found;
    const { path, machineId } = choice();
    const { project: made } = await call<ProjectResults["create"]>(
      "projects",
      "create",
      {
        path: path.trim(),
        ...(machineId === undefined ? {} : { machineId }),
        ...(stewardId === null ? {} : { stewardId }),
      },
    );
    return made;
  };
  return { choice, adding, project, chosenPlace, browse, missing, resolve };
}
