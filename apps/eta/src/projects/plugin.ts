/**
 * The `projects` plugin: directories on machines.
 *
 * A project is `machine + absolute path`, unique per machine. Making one checks the path is a
 * directory on that machine (for the primary, this filesystem); making one that exists returns
 * the one that exists. A project has no steward: that is each group's own (`conversations`).
 */
import type { ProjectView } from "@eta/client-contracts";
import type { MachineHub } from "../machines/hub";
import type { MachineRecord, MachineStore } from "../machines/store";
import type { MachinePlaces } from "../places/on-machine";
import type { PlaceStore } from "../places/store";
import type { ProjectRecord, ProjectStore } from "./store";
import { PlaceError } from "@eta/places";
import { transportOn } from "../machines/shell";
import { wireFailure } from "../places/on-machine";
import { Args, productPlugin, publish } from "../wire";
import { DEFAULT_FILE_LIMIT, listProjectFiles } from "./files";

export interface ProjectsDeps {
  machines: MachineStore;
  hub: MachineHub;
  projects: ProjectStore;
  /** Recent use, which making a project is. */
  places: PlaceStore;
  /** Paths are the machine's: `~`, drives and backslashes are answered there. */
  onMachine: MachinePlaces;
  changed: () => void;
}

export function projectsPlugin(deps: ProjectsDeps, applied: () => void) {
  const { machines, projects } = deps;

  /** What a client shows: the path as its machine writes it for a person (`~/Developer/eta`). */
  const viewOf = (project: ProjectRecord): ProjectView => {
    const machine = machines.get(project.machineId);
    return {
      ...project,
      display:
        machine === undefined
          ? project.path
          : deps.onMachine.rules(machine).display(project.path),
    };
  };

  const existing = (id: string): ProjectRecord => {
    const project = projects.get(id);
    if (project === undefined) throw new Error(`no such project: ${id}`);
    return project;
  };

  /** The machine a call names; the primary when it names none. */
  const machineOf = (args: Args): MachineRecord => {
    const machine =
      machines.get(
        args.optionalString("machineId") ?? machines.primary()?.id ?? "",
      ) ?? undefined;
    if (machine === undefined) throw new Error("no such machine");
    return machine;
  };

  return productPlugin(
    "projects",
    ({ wire }) => {
      const offs = [
        publish(
          wire,
          "projects",
          { list: () => projects.list().map(viewOf) },
          { eager: true },
        ),

        wire.handle("projects", "create", async (call) => {
          const args = new Args(call);
          const machine = machineOf(args);
          const raw = args.string("path");
          // By the machine's own rules, there: `C:\\code` is a path on a Windows daemon, and
          // `~/x` is its home's, whatever this host runs on.
          let resolved;
          try {
            resolved = await deps.onMachine.ask(machine, {
              op: "resolve",
              path: raw,
            });
          } catch (error) {
            throw wireFailure(error, raw);
          }
          const path = resolved.path;

          const found = projects.byPath(machine.id, path);
          if (found !== undefined) {
            // Adding it again is asking for it: one that was put away comes back.
            const project = found.archived
              ? projects.update(found.id, { archived: false })!
              : found;
            deps.places.remember(machine.id, path);
            deps.changed();
            return { result: { project: viewOf(project), existed: true } };
          }
          if (!resolved.exists)
            throw wireFailure(new PlaceError("not_found"), path);
          if (!resolved.directory)
            throw wireFailure(new PlaceError("not_directory"), path);
          const name = args.optionalString("name")?.trim();
          const project = projects.create({
            machineId: machine.id,
            path,
            name:
              name === undefined || name === ""
                ? deps.onMachine.rules(machine).name(path)
                : name,
          });
          deps.places.remember(machine.id, path);
          deps.changed();
          return { result: { project: viewOf(project), existed: false } };
        }),

        wire.handle("projects", "update", (call) => {
          const args = new Args(call);
          const id = args.string("projectId");
          existing(id);
          const name = args.optionalString("name")?.trim();
          if (name === "") throw new Error("a project needs a name");
          const project = projects.update(id, {
            name,
            archived: args.optionalBoolean("archived"),
          })!;
          deps.changed();
          return { result: { project: viewOf(project) } };
        }),

        wire.handle("projects", "files", async (call) => {
          const args = new Args(call);
          const project = existing(args.string("projectId"));
          const machine = machines.get(project.machineId);
          if (machine === undefined) throw new Error("no such machine");
          return {
            result: await listProjectFiles(
              transportOn(machine, deps.hub),
              project.path,
              args.optionalInteger("limit") ?? DEFAULT_FILE_LIMIT,
            ),
          };
        }),
      ];
      return () => {
        for (const off of offs.splice(0)) off();
      };
    },
    applied,
  );
}
