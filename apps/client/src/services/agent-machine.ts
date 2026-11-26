import type { AgentRuntime, MachineView } from "@eta/client-contracts";
import { isExternalRuntime } from "@eta/client-contracts";
import { localizedText } from "../i18n";

/** Minimal agent shape accepted by pickers and test fixtures alike. */
export interface AgentMachineRef {
  runtime?: AgentRuntime | undefined;
  machineId?: string | null | undefined;
}

/** Whether an agent's runtime is external to eta's own loop. */
function isExternalAgent(agent: AgentMachineRef): boolean {
  return agent.runtime !== undefined && isExternalRuntime(agent.runtime);
}

/**
 * Whether `agent` can participate or run in a regular project hosted on `machineId`.
 * Built-in `"eta"` agents (or fixtures omitting `runtime` / `machineId`) are always allowed; when
 * `machineId` is unknown (`undefined`), the check stays permissive for minimal fixtures.
 */
export function agentAllowedOnMachine(
  agent: AgentMachineRef,
  machineId: string | undefined,
): boolean {
  if (!isExternalAgent(agent)) return true;
  if (machineId === undefined) return true;
  return agent.machineId === machineId;
}

/**
 * Muted single-machine note shown when disabling an external agent whose pinned machine differs
 * from `targetMachineId`, or `undefined` when the agent can join.
 */
export function onlyOnMachineNote(
  agent: AgentMachineRef,
  targetMachineId: string | undefined,
  machines: readonly Pick<MachineView, "id" | "name">[],
): string | undefined {
  if (agentAllowedOnMachine(agent, targetMachineId)) return undefined;
  const label = agent.machineId
    ? (machines.find((m) => m.id === agent.machineId)?.name ?? agent.machineId)
    : undefined;
  if (label === undefined)
    return localizedText("Pinned to another machine", "固定在其他机器");
  return localizedText(`Only on ${label}`, `仅限 ${label}`);
}
