import type { Row } from "../../../ui/components/row-list";

/**
 * A project's line in the first step of `/new`: its name, then its path in the muted colour, and
 * the machine's name after it when the project is not on the primary machine.
 */
export function projectRow(
  project: { id: string; name: string; path: string; machineId: string },
  machines: readonly { id: string; name: string }[],
  primaryId: string | undefined,
): Row {
  const machine =
    project.machineId === primaryId
      ? undefined
      : machines.find((m) => m.id === project.machineId);
  return {
    key: project.id,
    label: project.name,
    note:
      machine === undefined ? project.path : `${project.path}  ${machine.name}`,
  };
}
