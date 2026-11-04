import type { MachineView, ProjectView } from "@eta/client-contracts";

/** The last segment of a path, for showing a folder by its name. */
export function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed.length === 0) return path;
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name.length === 0 ? trimmed : name;
}

/**
 * Where a project is, as one line: its path, with the machine's name in front when that machine is
 * not the primary (`gpu-box:/home/eric/training`).
 *
 * A path is unique only per machine, so `eta` on the primary and `eta` on a daemon at the same path
 * would otherwise read the same. Someone with one machine never sees a prefix. `short` writes the
 * machine's own home as `~` — that machine's, because a daemon's paths live under its home, not
 * the primary's. The machine list can arrive after the projects: until the project's machine is
 * in it, the line is the bare path rather than a guess.
 */
export function projectPlace(
  project: Pick<ProjectView, "machineId" | "path">,
  machines: readonly MachineView[],
  { short = false }: { short?: boolean } = {},
): string {
  const machine = machines.find(
    (candidate) => candidate.id === project.machineId,
  );
  if (machine === undefined) return project.path;
  const path = short ? shortenPath(project.path, machine.home) : project.path;
  return machine.kind === "primary" ? path : `${machine.name}:${path}`;
}

/** `~/Desktop/eta`, not `/Users/lemonhx/Desktop/eta`. */
export function shortenPath(path: string, home: string | null): string {
  if (home !== null && path.startsWith(`${home}/`))
    return `~/${path.slice(home.length + 1)}`;
  if (home !== null && path === home) return "~";
  return path;
}
