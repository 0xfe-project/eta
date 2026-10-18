import type { MachineArgs, MachineResults } from "@eta/client-contracts";
import { useWireMutation } from "@/queries/wire";

// The `machines` target's four actions. The list itself is `useMachines` (queries/projects.ts).

export function useEnrollMachine() {
  return useWireMutation<MachineArgs["enroll"], MachineResults["enroll"]>(
    "machines",
    "enroll",
  );
}

/** Only succeeds when `fingerprint` is the one the machine printed; the host does the comparing. */
export function useApproveMachine() {
  return useWireMutation<MachineArgs["approve"], MachineResults["approve"]>(
    "machines",
    "approve",
  );
}

export function useRevokeMachine() {
  return useWireMutation<MachineArgs["revoke"], MachineResults["revoke"]>(
    "machines",
    "revoke",
  );
}

export function useRenameMachine() {
  return useWireMutation<MachineArgs["rename"], MachineResults["rename"]>(
    "machines",
    "rename",
  );
}
