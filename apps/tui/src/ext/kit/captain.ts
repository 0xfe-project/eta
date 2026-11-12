import type { AgentView, ConversationSummary } from "@eta/client-contracts";

// Captain is eta's own agent, which the host makes when it starts, with a private conversation of
// its own. It is not one of the agents a person creates, edits or picks, and the desktop keeps it
// out of those lists too (its own section stands at the head of the sidebar). The TUI has no place
// for Captain yet, so its lists leave it out. Names are another matter: Captain speaks in groups,
// and a row it wrote still needs its name, so lookups by id keep reading the whole list.

type Role = Pick<AgentView, "systemRole">;

const isCaptain = (agent: Role) => agent.systemRole === "captain";

const ordinary = new WeakMap<readonly AgentView[], AgentView[]>();

/** The agents a person works with: the list without Captain, the same array for the same input. */
export function ordinaryAgents(agents: readonly AgentView[]): AgentView[] {
  let kept = ordinary.get(agents);
  if (kept === undefined) {
    kept = agents.filter((agent) => !isCaptain(agent));
    ordinary.set(agents, kept);
  }
  return kept;
}

const rowsKept = new WeakMap<
  readonly { agentId: string }[],
  { agents: readonly AgentView[] | undefined; kept: unknown[] }
>();

/** Rows that belong to an agent (an MCP server, say), without Captain's; cached like the rest. */
export function withoutCaptainRows<T extends { agentId: string }>(
  rows: readonly T[],
  agents: readonly AgentView[] | undefined,
): T[] {
  const cached = rowsKept.get(rows);
  if (cached !== undefined && cached.agents === agents)
    return cached.kept as T[];
  const captains = new Set(
    (agents ?? []).filter(isCaptain).map((agent) => agent.id),
  );
  const kept = rows.filter((row) => !captains.has(row.agentId));
  rowsKept.set(rows, { agents, kept });
  return kept;
}

const listed = new WeakMap<
  readonly ConversationSummary[],
  { agents: readonly AgentView[] | undefined; kept: ConversationSummary[] }
>();

/**
 * The conversations without Captain's own one: the private conversation whose only member is
 * Captain. Captain's word is in the agents list, so until that list has come nothing is left out.
 * The same arrays in give the same array out, so a selector that reads it does not render again.
 */
export function withoutCaptainConversation(
  conversations: readonly ConversationSummary[],
  agents: readonly AgentView[] | undefined,
): ConversationSummary[] {
  const cached = listed.get(conversations);
  if (cached !== undefined && cached.agents === agents) return cached.kept;
  const captains = new Set(
    (agents ?? []).filter(isCaptain).map((agent) => agent.id),
  );
  const kept =
    captains.size === 0
      ? [...conversations]
      : conversations.filter(
          (conversation) =>
            !(
              conversation.kind === "direct" &&
              conversation.participants.length === 1 &&
              captains.has(conversation.participants[0]!.agentId)
            ),
        );
  listed.set(conversations, { agents, kept });
  return kept;
}
