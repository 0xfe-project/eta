/**
 * Who a task is for, as the registry knows it.
 *
 * An agent names the assignee the way the user did: by its id, or by its name. The task row keeps
 * the registry's id and nothing else, since that is what a run looks the executor up by; a name
 * stored as it was written is a task that cannot run. So the name is resolved where the task is
 * written, and a name that names nobody, or more than one agent, is refused there, with the
 * agents there are: guessing would hand the work to someone the user did not mean.
 */
import type { AgentRecord, AgentStore } from "../agents/store";

const listed = (agents: readonly AgentRecord[]): string =>
  agents.length === 0
    ? "there are no agents"
    : `the agents are: ${agents.map((a) => `${a.name} (${a.id})`).join(", ")}`;

/**
 * The registry id of the agent `assignee` names: an id first, then a name (exactly, else ignoring
 * case) that only one agent has. Absent or blank is no assignee.
 */
export function resolveAssignee(
  assignee: string | undefined,
  agents: Pick<AgentStore, "get" | "list">,
): string | undefined {
  const wanted = assignee?.trim() ?? "";
  if (wanted === "") return undefined;
  const byId = agents.get(wanted);
  if (byId !== undefined) return byId.id;
  const all = agents.list();
  let named = all.filter((a) => a.name.trim() === wanted);
  if (named.length === 0) {
    const folded = wanted.toLowerCase();
    named = all.filter((a) => a.name.trim().toLowerCase() === folded);
  }
  if (named.length === 1) return named[0]!.id;
  if (named.length === 0)
    throw new Error(
      `no agent is "${wanted}" (assignee is an agent's name or id); ${listed(all)}`,
    );
  throw new Error(
    `more than one agent is called "${wanted}"; name the assignee by id: ${named.map((a) => a.id).join(", ")}`,
  );
}
