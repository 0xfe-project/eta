/**
 * The `projects` plugin: directories on machines.
 *
 * A project is `machine + absolute path`, unique per machine. Making one checks the path is a
 * directory on that machine (for the primary, this filesystem); making one that exists returns
 * the one that exists. A project has no steward: that is each group's own (`conversations`).
 */
import type { ProjectView } from "@eta/client-contracts";
import type { SshTransport } from "@eta/ssh";
import type { MachineHub } from "../machines/hub";
import type { MachineRecord, MachineStore } from "../machines/store";
import type { ProjectRecord, ProjectStore } from "./store";
import { basename, isAbsolute, resolve } from "node:path";
import { transportOn } from "../machines/shell";
import { Args, productPlugin, publish } from "../wire";
import { checkDirectory } from "./check";
import { DirectoryError, listDirectories } from "./directories";
import { DEFAULT_FILE_LIMIT, listProjectFiles } from "./files";

export interface ProjectsDeps {
  machines: MachineStore;
  hub: MachineHub;
  projects: ProjectStore;
  changed: () => void;
}

const viewOf = (project: ProjectRecord): ProjectView => ({ ...project });

export function projectsPlugin(deps: ProjectsDeps, applied: () => void) {
  const { machines, projects } = deps;

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
          if (!isAbsolute(raw))
            throw new Error(`the path must be absolute: ${raw}`);
          const path = resolve(raw);

          const found = projects.byPath(machine.id, path);
          if (found !== undefined) {
            // Adding it again is asking for it: one that was put away comes back.
            const project = found.archived
              ? projects.update(found.id, { archived: false })!
              : found;
            deps.changed();
            return { result: { project: viewOf(project), existed: true } };
          }
          await checkDirectory(machine, deps.hub, path);
          const name = args.optionalString("name")?.trim();
          const project = projects.create({
            machineId: machine.id,
            path,
            name:
              name === undefined || name === "" ? basename(path) || path : name,
          });
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

        wire.handle("projects", "directories", async (call) => {
          const args = new Args(call);
          const machine = machineOf(args);
          let transport: SshTransport;
          try {
            transport = transportOn(machine, deps.hub);
          } catch {
            throw new DirectoryError("offline");
          }
          const onMachine = projects
            .list()
            .filter((project) => project.machineId === machine.id);
          return {
            result: await listDirectories(
              transport,
              args.optionalString("path"),
              new Map(onMachine.map((project) => [project.path, project.id])),
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
