import { useListTarget, useWireMutation } from "@/queries/wire";

// External agents on the wire: the `acp` target (one `list` section, every ACP agent configured in
// ~/.eta/acp.json, as the host sees it) and its calls. The host keeps the file; the page only asks.
//
// The shapes below are the contract of task #167 (`packages/client-contracts/src/acp.ts`). Until
// that lands they live here, the only place the page reads them from; then this block becomes an
// import from `@eta/client-contracts`.

export interface AcpAgentConfig {
  /** A slug; the agent's runtime id is `acp.<id>`. */
  id: string;
  label: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Unset runs it in the session's working directory. */
  cwd?: string;
  /** Unset is false: permission requests ask the user. */
  autoAllow?: boolean;
}
export interface AcpAgentView extends AcpAgentConfig {
  runtime: `acp.${string}`;
  status: "available" | "unauthenticated" | "missing" | "error";
  version?: string;
  detail?: string;
}
export interface AcpTestResult {
  ok: boolean;
  status: AcpAgentView["status"];
  agentName?: string;
  version?: string;
  detail?: string;
  authMethods?: string[];
}
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

/** Every configured ACP agent, kept live: the host pushes the list again after each change. */
export function useAcpAgents() {
  const { items, loaded, error } = useListTarget<AcpAgentView>(TARGET);
  return { agents: items, loaded, error };
}

/** Create or overwrite by id; `previousId` set and different from `agent.id` renames. */
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
