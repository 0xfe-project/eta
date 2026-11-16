/**
 * ACP (Agent Client Protocol) agents as runtimes: what the host's `~/.eta/acp.json` holds, and
 * what the `acp` wire target says about it.
 *
 * Every configured agent is a runtime of its own, `acp.<id>`: an agent picks it like `claude` or
 * `codex`, and the host starts the configured command as a stdio child that speaks ACP.
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
  /** Where the process starts; the session's working directory when absent. */
  cwd?: string;
  /** Answer the agent's permission requests without asking the user. Off when absent. */
  autoAllow?: boolean;
}

/** One item of `acp.list`: the configuration, and what this host found when it looked. */
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

export const ACP_ACTIONS = ["list", "save", "delete", "test"] as const;
export type AcpAction = (typeof ACP_ACTIONS)[number];

/** What an ACP agent's id has to look like. */
export const ACP_AGENT_ID = /^[a-z0-9][a-z0-9-]*$/;
