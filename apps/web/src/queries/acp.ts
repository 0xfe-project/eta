import type {
  AcpAgentConfig,
  AcpAgentView,
  AcpMachineList,
  AcpTestResult,
} from "@eta/client-contracts";
import { useEffect } from "react";
import { getWire } from "@/lib/wire";
import { usePluginError, useTarget, useWireMutation } from "@/queries/wire";

// External agents on the wire: the `acp` target and its calls. Every machine keeps its own
// ~/.eta/acp.json; the target's one section, `machines`, is each known machine's list by machine
// id, and every call names the machine it is for. The host keeps the files; the page only asks.
// The shapes are the contract's (`packages/client-contracts/src/acp.ts`); the call arguments and
// results below are how this page names them.

export interface AcpArgs {
  refresh: { machineId: string };
  save: { machineId: string; agent: AcpAgentConfig; previousId?: string };
  delete: { machineId: string; id: string };
  test: { machineId: string; agent: AcpAgentConfig };
}
export interface AcpResults {
  refresh: AcpMachineList;
  save: AcpAgentView;
  delete: Record<string, never>;
  test: AcpTestResult;
}

const TARGET = "acp";
const NO_LISTS: Record<string, AcpMachineList> = {};
/**
 * Every listed machine's ACP agents, kept live: the host pushes a machine's list again after each
 * change, and again when the agents it started looking at have answered. Each machine in
 * `machineIds` (only the reachable ones: an offline daemon cannot be asked) is asked for its list
 * once it is named. `lists` holds what came, by machine id; a machine missing there has not
 * answered yet, and one whose acp.json cannot be read whole has its `error` (the message names the
 * file), never an empty list. `error` is the target's own: the host does not have it.
 */
export function useAcpLists(machineIds: readonly string[]) {
  const machines = useTarget(TARGET)?.sections.machines as
    | Record<string, AcpMachineList>
    | undefined;
  const failure = usePluginError(TARGET);
  const key = machineIds.join("\n");
  useEffect(() => {
    if (key === "") return;
    // What it answers arrives as the section; a failure here (it went offline meanwhile) is
    // shown by the machine's own status.
    for (const machineId of key.split("\n"))
      void getWire()
        .call(TARGET, "refresh", { machineId })
        .catch(() => undefined);
  }, [key]);
  return {
    lists: machines ?? NO_LISTS,
    loaded: machines !== undefined,
    error: machines === undefined ? failure : undefined,
  };
}

/**
 * Without `previousId` adds (the machine refuses an id it already has); `previousId` equal to
 * `agent.id` changes that agent in place; a different `previousId` renames it.
 */
export function useSaveAcpAgent() {
  return useWireMutation<AcpArgs["save"], AcpResults["save"]>(TARGET, "save", {
    timeoutMs: 30_000,
  });
}

export function useDeleteAcpAgent() {
  return useWireMutation<AcpArgs["delete"], AcpResults["delete"]>(
    TARGET,
    "delete",
  );
}

/** Start the agent on the machine and shake hands; a draft that was never saved can be tried too. */
export function useTestAcpAgent() {
  return useWireMutation<AcpArgs["test"], AcpResults["test"]>(TARGET, "test", {
    timeoutMs: 60_000,
  });
}
