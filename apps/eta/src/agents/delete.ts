/**
 * Deleting an ordinary agent cleanly: stop active replies and task runs first, tell every
 * conversation policy, archive its home project on the primary, and delete the agent row inside
 * one SQLite transaction.
 */
import type { Database } from "bun:sqlite";
import type { Engine } from "../conversations/engine";
import type { ConversationPolicies } from "../conversations/policy";
import type { MachineStore } from "../machines/store";
import type { ProjectStore } from "../projects/store";
import type { TaskRunner } from "../tasks/runner";
import type { AgentRecord, AgentStore } from "./store";
import { homeOf } from "./home";

export interface DeleteAgentTxDeps {
  dataDir: string;
  agents: AgentStore;
  machines: MachineStore;
  projects: ProjectStore;
  policies: ConversationPolicies;
}

export interface DeleteAgentDeps extends DeleteAgentTxDeps {
  db: Database;
  engine: Pick<Engine, "stopAgent">;
  runner?: Pick<TaskRunner, "stopAgent"> | undefined;
}

/**
 * Perform the DB mutations of deleting an agent inside an existing SQLite transaction:
 * run conversation policy hooks, archive its `agent_home` project on primary, and remove its row.
 */
export function deleteAgentInTransaction(
  deps: DeleteAgentTxDeps,
  agent: AgentRecord,
  options?: { captainMessage?: string },
): void {
  if (agent.systemRole === "captain") {
    throw new Error(
      options?.captainMessage ??
        "the Captain cannot be deleted as an ordinary agent",
    );
  }
  deps.policies.agentDeleted(agent);
  const home = homeOf(deps, agent);
  if (home !== undefined) deps.projects.update(home.id, { archived: true });
  // Stewards and memberships go with the row (ON DELETE SET NULL / CASCADE).
  deps.agents.remove(agent.id);
}

/**
 * Validate, stop active replies and open task runs, and delete an agent in one transaction.
 */
export function deleteAgent(
  deps: DeleteAgentDeps,
  agentId: string,
  options?: { reason?: string; captainMessage?: string },
): AgentRecord {
  const agent = deps.agents.get(agentId);
  if (agent === undefined) throw new Error(`no such agent: ${agentId}`);
  if (agent.systemRole === "captain") {
    throw new Error(
      options?.captainMessage ??
        "the Captain cannot be deleted as an ordinary agent",
    );
  }
  // Stop active replies and open task runs first so nothing outlives the deleted agent.
  deps.engine.stopAgent(agent.id);
  deps.runner?.stopAgent(
    agent.id,
    options?.reason ?? `Agent ${agent.name} was deleted.`,
  );
  deps.db.transaction(() => {
    deleteAgentInTransaction(deps, agent, options);
  })();
  return agent;
}
