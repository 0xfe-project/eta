/**
 * The `projects` plugin: directories on machines, and who stewards them.
 *
 * A project is `machine + absolute path`, unique per machine. Making one checks the path is a
 * directory on that machine (for the primary, this filesystem); making one that exists returns
 * the one that exists. The steward is the agent who takes what nobody is named for; switching it
 * writes a system row into every conversation that follows the project.
 */
import type { ProjectView } from "@eta/client-contracts";
import type { AgentStore } from "../agents/store";
import type { ConversationStore } from "../conversations/store";
import type { Timeline } from "../conversations/timeline";
import type { MachineHub } from "../machines/hub";
import type { MachineRecord, MachineStore } from "../machines/store";
import type { ProjectRecord, ProjectStore } from "./store";
import { stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { announceSteward } from "../conversations/steward";
import { transportOn } from "../machines/shell";
import { Args, productPlugin, publish } from "../wire";
import { DEFAULT_FILE_LIMIT, listProjectFiles } from "./files";

export interface ProjectsDeps {
  agents: AgentStore;
  machines: MachineStore;
  hub: MachineHub;
  projects: ProjectStore;
  conversations: ConversationStore;
  timeline: Timeline;
  changed: (conversations?: readonly string[] | "all") => void;
}

const viewOf = (project: ProjectRecord): ProjectView => ({ ...project });

/**
 * Whether `path` is a directory on the machine; says why not otherwise. A daemon machine is asked:
 * the path means something on its filesystem, and it is the only one who can say.
 */
async function checkDirectory(
  machine: MachineRecord,
  hub: MachineHub,
  path: string,
): Promise<void> {
  if (machine.kind === "daemon") {
    const link = hub.link(machine.id);
    if (link === undefined) {
      throw new Error(
        `${machine.name} is ${machine.status}, so ${path} cannot be checked`,
      );
    }
    const answer = await link.machine("stat", { path });
    if (!answer.ok) throw new Error(answer.reason);
    return;
  }
  if (machine.kind !== "primary")
    throw new Error(`${machine.name} cannot be reached from this host yet`);
  const found = await stat(path).catch(() => undefined);
  if (found === undefined) throw new Error(`no such directory: ${path}`);
  if (!found.isDirectory()) throw new Error(`not a directory: ${path}`);
}

export function projectsPlugin(deps: ProjectsDeps, applied: () => void) {
  const { agents, machines, projects, conversations, timeline } = deps;

  const existing = (id: string): ProjectRecord => {
    const project = projects.get(id);
    if (project === undefined) throw new Error(`no such project: ${id}`);
    return project;
  };

  const steward = (id: string | null | undefined): string | null => {
    if (id === undefined || id === null) return null;
    if (agents.get(id) === undefined) throw new Error(`no such agent: ${id}`);
    return id;
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
          const machine =
            machines.get(
              args.optionalString("machineId") ?? machines.primary()?.id ?? "",
            ) ?? undefined;
          if (machine === undefined) throw new Error("no such machine");
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
            stewardId: steward(args.nullableString("stewardId")),
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

        wire.handle("projects", "setSteward", (call) => {
          const args = new Args(call);
          const before = existing(args.string("projectId"));
          const sent = args.nullableString("agentId");
          if (sent === undefined)
            throw new Error("projects.setSteward needs agentId (or null)");
          const agentId = steward(sent);
          const noted: string[] = [];
          projects.setSteward(before.id, agentId);
          // The conversations that follow the project are the ones whose steward just changed.
          // A private chat has only its agent to talk to, and a conversation with a steward of
          // its own did not change.
          for (const conversation of conversations.ofProject(before.id)) {
            if (
              conversation.kind === "direct" ||
              conversation.archived ||
              conversation.stewardId !== null
            )
              continue;
            if (
              announceSteward(
                { agents, timeline },
                conversation.id,
                before.stewardId,
                agentId,
              ) !== undefined
            )
              noted.push(conversation.id);
          }
          deps.changed(noted);
          return { result: { project: viewOf(existing(before.id)) } };
        }),
      ];
      return () => {
        for (const off of offs.splice(0)) off();
      };
    },
    applied,
  );
}
