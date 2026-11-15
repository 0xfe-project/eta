/**
 * Captain proposes an agent (`propose_agent`); confirming it makes the agent the way the agent
 * dialog does (`createAgent`): its workspace, its home project on the primary machine, and its first
 * instructions and persona versions, recorded as Captain's.
 *
 * The persona is one of the cards that already exist, and the agent keeps its id — sessions find
 * the card by it — so no card is written and none is copied.
 */
import type {
  AgentRuntime,
  CaptainAgentProposal,
  CaptainAgentResult,
} from "@eta/client-contracts";
import type { PersonaCard } from "@eta/core";
import type { AgentCreateDeps } from "../agents/create";
import type { ProposalKind, ProposalOrigin } from "./proposals";
import { describeCard, discoverPersonas } from "@eta/server";
import { checkNewAgent, createAgent } from "../agents/create";

/** What Captain asks for when it proposes an agent. */
export interface AgentProposalInput {
  name: string;
  purpose: string;
  instructions: string;
  /** The id of an existing card. Never a new card. */
  persona: string;
  /** Chosen by the user: there is no default. */
  model: string;
  runtime?: AgentRuntime | undefined;
  plugins?: readonly string[] | undefined;
}

/** An agent proposal as it is stored, without where it was proposed. */
type AgentProposal = Omit<CaptainAgentProposal, keyof ProposalOrigin>;

export interface AgentProposalDeps extends AgentCreateDeps {
  /**
   * The user's home, where the persona cards they wrote live. A new agent's own workspace is an
   * empty directory, so this is the only place a card can come from besides the built-in ones.
   */
  home: string;
  warn: (message: string) => void;
}

/**
 * The cards a new agent could wear. Its workspace is an empty directory, so the cards are the
 * built-in ones and the user's own: `cwd` is the home for the same reason, and the two identical
 * directories cost one read because the result is keyed by id.
 */
async function personaCards(
  deps: AgentProposalDeps,
): Promise<Map<string, PersonaCard>> {
  return await discoverPersonas({
    cwd: deps.home,
    home: deps.home,
    warn: deps.warn,
  });
}

/** The cards, as the one line each that a chooser reads. */
export async function listPersonaCards(
  deps: AgentProposalDeps,
): Promise<{ id: string; summary: string }[]> {
  return [...(await personaCards(deps)).values()].map((card) => ({
    id: card.id,
    summary: describeCard(card),
  }));
}

export function agentProposals(
  deps: AgentProposalDeps,
): ProposalKind<AgentProposalInput, AgentProposal, CaptainAgentResult> {
  return {
    kind: "create_agent",
    noun: "agent",

    /**
     * Refused: what `agents.create` refuses (a name another agent answers to, a model that is not
     * `provider:modelId`, a plugin that cannot be enabled), and besides that an empty purpose or
     * instructions, a card that is not there, or a system role smuggled into the payload.
     */
    async check(input) {
      // The payload is JSON; the Captain's own role is not one a proposal may make.
      if ("systemRole" in input)
        throw new Error("a proposed agent cannot carry a system role");
      const purpose = input.purpose.trim();
      const instructions = input.instructions.trim();
      const model = input.model.trim();
      const runtime = input.runtime ?? "eta";
      const plugins = [...new Set(input.plugins ?? [])];
      if (input.name.trim() === "") throw new Error("an agent needs a name");
      if (purpose === "") throw new Error("an agent needs a purpose");
      if (instructions === "")
        throw new Error("instructions must not be empty");
      if (model === "") throw new Error("an agent needs a model");
      checkNewAgent(deps, { name: input.name, runtime, model, plugins });
      const card = (await personaCards(deps)).get(input.persona);
      if (card === undefined)
        throw new Error(`no such persona card: ${input.persona}`);
      return {
        name: input.name.trim(),
        purpose,
        instructions,
        persona: card.id,
        model,
        runtime,
        plugins,
      };
    },

    async apply(proposal, operation) {
      const { agent, project } = await createAgent(
        deps,
        {
          name: proposal.name,
          instructions: proposal.instructions,
          persona: proposal.persona,
          runtime: proposal.runtime,
          model: proposal.model,
          plugins: proposal.plugins,
        },
        operation.actorAgentId,
      );
      return { agentId: agent.id, projectId: project.id, name: agent.name };
    },

    created: (_proposal, result) => [
      `agentId: ${result.agentId}`,
      `projectId: ${result.projectId}`,
      "It is in no group yet: propose_group with its id as a member, then assign work there with assign_in_group.",
    ],
  };
}
