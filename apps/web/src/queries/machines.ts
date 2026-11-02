import type { MachineArgs, MachineResults } from "@eta/client-contracts";
import { useQuery } from "@tanstack/react-query";
import { getWire } from "@/lib/wire";
import { useWireMutation } from "@/queries/wire";

// The `machines` target's actions. The list itself is `useMachines` (queries/projects.ts).

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

/** How many task runs the machine works on at once. */
export function useSetMaxActiveRuns() {
  return useWireMutation<
    MachineArgs["setMaxActiveRuns"],
    MachineResults["setMaxActiveRuns"]
  >("machines", "setMaxActiveRuns");
}

/** Replace a connected daemon with the build the host carries, now. */
export function useUpgradeMachine() {
  return useWireMutation<MachineArgs["upgrade"], MachineResults["upgrade"]>(
    "machines",
    "upgrade",
  );
}

/** The tailnet's nodes, asked once when the add dialog opens (`enabled`). */
export function useDiscoverMachines(enabled: boolean) {
  return useQuery({
    queryKey: ["wire", "machines", "discover"],
    queryFn: async () =>
      await getWire().call<MachineResults["discover"]>(
        "machines",
        "discover",
        {},
      ),
    enabled,
    staleTime: 0,
  });
}

/** Put the daemon on a computer over SSH and register it. */
export function useInstallMachine() {
  return useWireMutation<MachineArgs["install"], MachineResults["install"]>(
    "machines",
    "install",
  );
}

export function useRenameMachine() {
  return useWireMutation<MachineArgs["rename"], MachineResults["rename"]>(
    "machines",
    "rename",
  );
}
