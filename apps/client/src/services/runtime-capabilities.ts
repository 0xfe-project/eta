import type {
  AgentRuntimeCapabilities,
  AgentRuntimeInfo,
  MemberView,
} from "@eta/client-contracts";
import type { useHost } from "./host";
import { signal } from "nsh";
import { askRuntimes } from "../pages/settings/runtimes/status";

type Host = ReturnType<typeof useHost>;

/**
 * What runtimes declared, per host, machine and runtime (`null`: it declared nothing, or could not
 * be asked). Each is asked once, and only that runtime is loaded on the host for it.
 */
const declared = signal<Record<string, AgentRuntimeCapabilities | null>>({});
const asked = new Set<string>();

/** Remember a listing's answers, from any screen that has one in hand (the agent editor). */
export function rememberRuntimes(
  host: Host,
  machineId: string | null | undefined,
  runtimes: readonly AgentRuntimeInfo[],
) {
  const origin = host.address()?.origin ?? "";
  declared.update((known) => {
    const next = { ...known };
    for (const runtime of runtimes)
      next[`${origin}|${machineId ?? ""}|${runtime.id}`] =
        runtime.capabilities ?? null;
    return next;
  });
}

/**
 * What a session of this agent takes. A member whose session the host has in hand says it (that
 * session's own answer); otherwise it is what the agent's runtime declares on its machine, asked of
 * the host once. Undefined means not known (eta's own loop, a host too old to say, a runtime still
 * being asked): a control is hidden only where the answer is an explicit no.
 */
export function capabilitiesOf(
  host: Host,
  agentId: string,
  options: { member?: MemberView; machineId?: string | null } = {},
): AgentRuntimeCapabilities | undefined {
  if (options.member?.capabilities) return options.member.capabilities;
  const agent = host.agent(agentId);
  if (!agent || agent.runtime === "eta") return undefined;
  const machineId = agent.machineId ?? options.machineId ?? null;
  const key = `${host.address()?.origin ?? ""}|${machineId ?? ""}|${agent.runtime}`;
  const known = declared()[key];
  if (known === undefined && !asked.has(key) && host.can("agents.runtimes")) {
    asked.add(key);
    const runtime = agent.runtime;
    // Asked after this read: a read inside a render does not write.
    queueMicrotask(() => {
      void askRuntimes(host, machineId, false, [runtime]).then(
        (runtimes) => rememberRuntimes(host, machineId, runtimes),
        () => declared.update((all) => ({ ...all, [key]: null })),
      );
    });
  }
  return known ?? undefined;
}

/** Whether none of these agents takes something, by explicit answers only. */
export function noneTakes(
  all: readonly (AgentRuntimeCapabilities | undefined)[],
  what: "steer" | "images",
): boolean {
  return all.length > 0 && all.every((one) => one?.[what] === false);
}
