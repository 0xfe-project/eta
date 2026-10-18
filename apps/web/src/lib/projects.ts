import type {
  ConversationSummary,
  MachineView,
  ProjectView,
} from "@eta/client-contracts";

/**
 * The sidebar's tree: conversations under the project they work in.
 *
 * A conversation belongs to a project (a directory on a machine) before it belongs to a list of
 * chats: its members run there, its tasks and artifacts are about that work. So the project is the
 * heading and the conversations sit under it. Private chats live in the agents' own workspaces
 * (projects of kind `agent_home`); a heading per agent that said the agent's name twice is noise,
 * so they are one section of their own.
 *
 * With more than one machine the projects are grouped by machine first; with one, the machine is
 * not worth a heading.
 */

interface ProjectSection {
  /** The project's id, or `"direct"` for the private chats. */
  key: string;
  /** What the heading says; widened when two projects would read the same. */
  label: string;
  /** The absolute path, for the heading's tooltip and the new-conversation link. */
  path: string;
  /** Private chats rather than a project. */
  direct: boolean;
  project: ProjectView | undefined;
  conversations: ConversationSummary[];
}

export interface MachineGroup {
  machine: MachineView | undefined;
  sections: ProjectSection[];
}

/** The last segment of a path, for showing a folder by its name. */
export function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed.length === 0) return path;
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name.length === 0 ? trimmed : name;
}

/** The name each path is shown by, widened (parent first) until nothing else reads the same. */
function folderLabels(paths: readonly string[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    let depth = 1;
    for (; depth < parts.length; depth += 1) {
      const candidate = parts.slice(-depth).join("/");
      const collides = paths.some(
        (other) =>
          other !== path &&
          other.split("/").filter(Boolean).slice(-depth).join("/") ===
            candidate,
      );
      if (!collides) break;
    }
    labels.set(path, parts.slice(-depth).join("/") || path);
  }
  return labels;
}

const activity = (conversation: ConversationSummary) =>
  conversation.lastMessageAt ?? conversation.updatedAt;

const newestFirst = (a: ConversationSummary, b: ConversationSummary) =>
  activity(b) - activity(a);

/** Whether a conversation matches a search: its name, its project, or one of its members. */
export function matchesQuery(
  conversation: ConversationSummary,
  project: ProjectView | undefined,
  memberNames: readonly string[],
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return [
    conversation.name,
    project?.name ?? "",
    project?.path ?? "",
    ...memberNames,
  ].some((text) => text.toLowerCase().includes(needle));
}

/**
 * The tree for the conversations that are not archived and match `matches`. Projects with nothing
 * in them are kept while nothing is searched for, so a new project has a "+" to start in.
 */
export function projectTree(input: {
  conversations: readonly ConversationSummary[];
  projects: readonly ProjectView[];
  machines: readonly MachineView[];
  matches: (
    conversation: ConversationSummary,
    project: ProjectView | undefined,
  ) => boolean;
  searching: boolean;
}): MachineGroup[] {
  const byId = new Map(input.projects.map((project) => [project.id, project]));
  const shown = input.conversations.filter(
    (conversation) =>
      !conversation.archived &&
      input.matches(conversation, byId.get(conversation.projectId)),
  );
  const direct = shown.filter((c) => c.kind === "direct");
  const inProject = new Map<string, ConversationSummary[]>();
  for (const conversation of shown) {
    if (conversation.kind === "direct") continue;
    inProject.set(conversation.projectId, [
      ...(inProject.get(conversation.projectId) ?? []),
      conversation,
    ]);
  }
  const listed = input.projects.filter(
    (project) =>
      !project.archived &&
      (inProject.has(project.id) ||
        (!input.searching && project.kind === "project")),
  );
  const labels = folderLabels(listed.map((project) => project.path));
  const sections: (ProjectSection & { machineId: string })[] = listed
    .map((project) => ({
      key: project.id,
      label:
        project.name === folderName(project.path)
          ? (labels.get(project.path) ?? project.name)
          : project.name,
      path: project.path,
      direct: false,
      project,
      machineId: project.machineId,
      conversations: [...(inProject.get(project.id) ?? [])].sort(newestFirst),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const groups: MachineGroup[] =
    input.machines.length > 1
      ? input.machines.map((machine) => ({
          machine,
          sections: sections.filter((s) => s.machineId === machine.id),
        }))
      : [{ machine: undefined, sections }];
  if (direct.length > 0) {
    groups[0] ??= { machine: undefined, sections: [] };
    // The private chats come first: they are the people, and the projects are what they work on.
    groups[0].sections.unshift({
      key: "direct",
      label: "",
      path: "",
      direct: true,
      project: undefined,
      conversations: [...direct].sort(newestFirst),
    });
  }
  return groups.filter((group) => group.sections.length > 0);
}
