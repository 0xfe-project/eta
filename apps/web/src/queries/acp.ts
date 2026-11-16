import type {
  AcpAgentConfig,
  AcpAgentView,
  AcpTestResult,
} from "@eta/client-contracts";
import { useListTarget, useTarget, useWireMutation } from "@/queries/wire";

// External agents on the wire: the `acp` target (one `list` section, every ACP agent configured in
// ~/.eta/acp.json, as the host sees it) and its calls. The host keeps the file; the page only asks.
// The shapes are the contract's (`packages/client-contracts/src/acp.ts`); the call arguments and
// results below are how this page names them.

export interface AcpArgs {
  save: { agent: AcpAgentConfig; previousId?: string };
  delete: { id: string };
  test: { agent: AcpAgentConfig };
}
export interface AcpResults {
  save: AcpAgentView;
  delete: Record<string, never>;
  test: AcpTestResult;
}

const TARGET = "acp";

/**
 * Every configured ACP agent, kept live: the host pushes the list again after each change. When
 * the host cannot read acp.json whole, the target carries an `error` section (its message names
 * the file) instead of a list: that is the page's error, never an empty list.
 */
export function useAcpAgents() {
  const { items, loaded, error } = useListTarget<AcpAgentView>(TARGET);
  const failure = (
    useTarget(TARGET)?.sections.error as { message?: unknown } | undefined
  )?.message;
  if (typeof failure === "string")
    return { agents: items, loaded: false, error: new Error(failure) };
  return { agents: items, loaded, error };
}

/**
 * Without `previousId` adds (the host refuses an id already taken); `previousId` equal to
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

/** Start the agent and shake hands; a draft that was never saved can be tried too. */
export function useTestAcpAgent() {
  return useWireMutation<AcpArgs["test"], AcpResults["test"]>(TARGET, "test", {
    timeoutMs: 60_000,
  });
}
