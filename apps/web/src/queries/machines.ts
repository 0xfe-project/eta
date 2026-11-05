import type {
  MachineArgs,
  MachineInstallView,
  MachineResults,
} from "@eta/client-contracts";
import { useQuery } from "@tanstack/react-query";
import { getWire } from "@/lib/wire";
import { useTarget, useWireMutation } from "@/queries/wire";

// The `machines` target's actions. The list itself is `useMachines` (queries/projects.ts).

export function useEnrollMachine() {
  return useWireMutation<MachineArgs["enroll"], MachineResults["enroll"]>(
    "machines",
    "enroll",
  );
}

/** The link the phone app scans; it carries the access token. */
export function usePhoneLink() {
  return useWireMutation<MachineArgs["phoneLink"], MachineResults["phoneLink"]>(
    "machines",
    "phoneLink",
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

/** The tailnet's nodes, asked afresh each time the SSH way of adding a machine shows. */
export function useDiscoverMachines() {
  return useQuery({
    queryKey: ["wire", "machines", "discover"],
    queryFn: async () =>
      await getWire().call<MachineResults["discover"]>(
        "machines",
        "discover",
        {},
      ),
    staleTime: 0,
  });
}

/** The addresses a new machine can dial besides the page's own: the host's tailnet one. */
export function useMachineAddresses() {
  return useQuery({
    queryKey: ["wire", "machines", "addresses"],
    queryFn: async () =>
      await getWire().call<MachineResults["addresses"]>(
        "machines",
        "addresses",
        {},
      ),
  });
}

const NO_INSTALLS: readonly MachineInstallView[] = [];

/** The installs over SSH as they go, newest first. */
export function useMachineInstalls(): readonly MachineInstallView[] {
  return (
    (useTarget("machines")?.sections.installs as
      | readonly MachineInstallView[]
      | undefined) ?? NO_INSTALLS
  );
}

/** Put the daemon on a computer over SSH and register it; the steps show in `useMachineInstalls`. */
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
