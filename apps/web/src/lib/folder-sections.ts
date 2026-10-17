import type { Group } from "@/queries/chat";
import { folderName, groupCwd } from "@/lib/group-cwd";

/**
 * The sidebar's tree: conversations grouped by the directory they work in.
 *
 * A conversation belongs to a project before it belongs to a list of chats — its members run
 * there, its notes come from there, its tasks and artifacts are about that work. So the folder is
 * the group heading and the conversations sit under it.
 *
 * Two groups of the same folder name in different places are normal (`~/work/api` and
 * `~/side/api`), and two headings reading "api" is a list you cannot navigate. The label is
 * widened until it is unique — parent first, and only as far up as it has to go.
 *
 * Conversations with no folder are not hidden and not merged into some folder: they are their own
 * section, sorted last, because "this one does not know where it works" is a state worth seeing.
 */

export interface FolderSection {
  /** `""` for the unbound section; otherwise the absolute path. */
  path: string;
  /** What the heading says: the folder's name, widened when two folders would read the same. */
  label: string;
  /** True for the section holding conversations with no folder. */
  unbound: boolean;
  groups: Group[];
}

/** The name a folder is shown by, unique among `paths`. */
export function folderLabels(paths: readonly string[]): Map<string, string> {
  const labels = new Map<string, string>();
  const segments = paths.map((path) => path.split("/").filter(Boolean));
  const width = new Map<string, number>();
  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    width.set(path, 1);
    // Widen until nothing else collides with this label.
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const candidate = parts.slice(-depth).join("/");
      const collides = paths.some((other) => {
        if (other === path) return false;
        const otherParts = other.split("/").filter(Boolean);
        return otherParts.slice(-depth).join("/") === candidate;
      });
      width.set(path, depth);
      if (!collides) break;
    }
  }
  for (const [index, path] of paths.entries()) {
    const parts = segments[index]!;
    const depth = Math.min(width.get(path) ?? 1, parts.length);
    labels.set(path, parts.slice(-depth).join("/"));
  }
  return labels;
}

const activity = (group: Group): string =>
  group.last_message_at ?? group.updated_at ?? "";

/** The tree, newest activity first within each folder, folders by path. */
export function folderSections(groups: readonly Group[]): FolderSection[] {
  const byPath = new Map<string, Group[]>();
  for (const group of groups) {
    const path = groupCwd(group);
    const bucket = byPath.get(path);
    if (bucket === undefined) byPath.set(path, [group]);
    else bucket.push(group);
  }
  const bound = [...byPath.keys()].filter((path) => path.length > 0).sort();
  const labels = folderLabels(bound);
  const newestFirst = (a: Group, b: Group) =>
    activity(b).localeCompare(activity(a));
  const sections: FolderSection[] = bound.map((path) => ({
    path,
    label: labels.get(path) ?? folderName(path),
    unbound: false,
    groups: [...byPath.get(path)!].sort(newestFirst),
  }));
  const unbound = byPath.get("");
  if (unbound !== undefined && unbound.length > 0) {
    sections.push({
      path: "",
      label: "",
      unbound: true,
      groups: [...unbound].sort(newestFirst),
    });
  }
  return sections;
}

/** Whether a conversation matches a search: its name, or the folder it is in. */
export function matchesQuery(group: Group, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  const cwd = groupCwd(group).toLowerCase();
  return group.name.toLowerCase().includes(needle) || cwd.includes(needle);
}
