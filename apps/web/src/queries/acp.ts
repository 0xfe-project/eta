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
const NONE: AcpAgentView[] = [];

/**
 * One machine's ACP agents, kept live: the host pushes the list again after each change, and
 * again when the agents it started looking at have answered. A daemon's list is asked for when
 * the page comes to it (`enabled`: only while it is online). When the machine cannot read its
 * acp.json whole, `error` says so (its message names the file): that is the page's error, never
 * an empty list.
 */
export function useAcpAgents(machineId: string | undefined, enabled = true) {
  const machines = useTarget(TARGET)?.sections.machines as
    | Record<string, AcpMachineList>
    | undefined;
  const failure = usePluginError(TARGET);
  useEffect(() => {
    if (machineId === undefined || !enabled) return;
    // What it answers arrives as the section; a failure here (it went offline meanwhile) is
    // shown by the machine's own status.
    void getWire()
      .call(TARGET, "refresh", { machineId })
      .catch(() => undefined);
  }, [machineId, enabled]);
  const list = machineId === undefined ? undefined : machines?.[machineId];
  if (list?.error !== undefined)
    return { agents: NONE, loaded: false, error: new Error(list.error) };
  return {
    agents: list?.agents ?? NONE,
    loaded: list !== undefined,
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
