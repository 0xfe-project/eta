import type { MachineView, ProjectView } from "@eta/client-contracts";

/** The last part of a path as its machine writes it, for showing a folder by its name. */
export function folderName(path: string): string {
  const name = path.split(/[\\/]/).filter(Boolean).at(-1);
  return name ?? path;
}

/**
 * Where a project is, as one line: its path, with the machine's name in front when that machine is
 * not the primary (`gpu-box:/home/eric/training`).
 *
 * A path is unique only per machine, so `eta` on the primary and `eta` on a daemon at the same path
 * would otherwise read the same. Someone with one machine never sees a prefix. `short` is the path
 * as its machine writes it (`display`: `~/…` under that machine's home, by its rules), which the
 * host works out; nothing here takes a path apart. The machine list can arrive after the projects:
 * until the project's machine is in it, the line is the bare path rather than a guess.
 */
export function projectPlace(
  project: Pick<ProjectView, "machineId" | "path" | "display">,
  machines: readonly MachineView[],
  { short = false }: { short?: boolean } = {},
): string {
  const machine = machines.find(
    (candidate) => candidate.id === project.machineId,
  );
  if (machine === undefined) return project.path;
  const path = short ? project.display : project.path;
  return machine.kind === "primary" ? path : `${machine.name}:${path}`;
}
