import type { MachineView } from "@eta/client-contracts";
/** The machines with a skill file service: the primary and every daemon not revoked. */
export function skillMachines(machines: readonly MachineView[]): MachineView[] {
  return machines
    .filter(
      (machine) =>
        (machine.kind === "primary" || machine.kind === "daemon") &&
        machine.status !== "revoked",
    )
    .sort(
      (a, b) => Number(b.kind === "primary") - Number(a.kind === "primary"),
    );
}

export function machineName(
  machine: MachineView,
  primarySuffix: string,
): string {
  return `${machine.name}${machine.kind === "primary" ? primarySuffix : ""}`;
}
