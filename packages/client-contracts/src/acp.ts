/**
 * ACP (Agent Client Protocol) agents as runtimes: what each machine's `~/.eta/acp.json` holds, and
 * what the `acp` wire target says about it.
 *
 * Every configured agent is a runtime of its own, `acp.<id>`, on the machine whose file lists it:
 * an agent picks it like `claude` or `codex`, and that machine starts the configured command as a
 * stdio child that speaks ACP, in the session's working directory. Its permission requests are
 * all answered yes. The same id on two machines is two separate agents.
 */

/** One ACP agent, as the user configured it. */
export interface AcpAgentConfig {
  /** A slug, `/^[a-z0-9][a-z0-9-]*$/`; the runtime id is `acp.<id>`. */
  id: string;
  label: string;
  /** The command to start; required. */
  command: string;
  args: string[];
  env: Record<string, string>;
}

export const ANTIGRAVITY_ACP_AGENT: AcpAgentConfig = {
  id: "antigravity",
  label: "Antigravity",
  command: "agy",
  args: ["acp", "--process-per-session"],
  env: {},
};

/** One agent in a machine's list: the configuration, and what that machine found when it looked. */
export interface AcpAgentView extends AcpAgentConfig {
  runtime: `acp.${string}`;
  /** As `AgentRuntimeInfo.status`. */
  status: "available" | "unauthenticated" | "missing" | "error";
  version?: string;
  detail?: string;
}

export interface AcpTestResult {
  ok: boolean;
  status: AcpAgentView["status"];
  /** The `agentInfo` name `initialize` answered with. */
  agentName?: string;
  version?: string;
  /** Why it failed, or what to do when the agent wants a sign-in. */
  detail?: string;
  /** The names of the sign-in methods `initialize` answered with. */
  authMethods?: string[];
}

/**
 * One machine's agents in the `acp` target's `machines` section, by machine id: the list, or why
 * its file cannot be read whole (then nothing on that machine can be changed). A daemon is there
 * once it was asked for (`acp.refresh`) while online.
 */
export type AcpMachineList =
  | { agents: AcpAgentView[]; error?: undefined }
  | { error: string; agents?: undefined };

/**
 * The `acp` target's calls. Each takes a `machineId` (the primary when absent); a daemon that is
 * not online is an error, never the primary instead.
 */
export const ACP_ACTIONS = ["refresh", "save", "delete", "test"] as const;
export type AcpAction = (typeof ACP_ACTIONS)[number];

/** What an ACP agent's id has to look like. */
export const ACP_AGENT_ID = /^[a-z0-9][a-z0-9-]*$/;
