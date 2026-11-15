/**
 * Captain proposes an agent; the user's confirmation makes it.
 *
 * The two tools are Captain's alone. A proposal makes nothing: it is a pending `create_agent`
 * operation and a card in the conversation it came from, carrying the name, the purpose, the
 * instructions, the persona card it would wear and the model the user picked. Confirming makes the
 * agent, its workspace and its home project, and starts its instructions and persona histories;
 * rejecting makes nothing. A name another agent answers to stops it at both points, and a proposal
 * may not make a card of its own: the agent keeps the card's id, the card is left alone.
 *
 * Once the user decides, Captain is told in the conversation it proposed from. That message is for a
 * proposal only: an agent the user makes in the agent dialog is no operation, so nothing is said
 * about it.
 */
import type {
  CaptainAgentProposal,
  CaptainOperationView,
} from "@eta/client-contracts";
import type { AgentProposalInput } from "../src/captain/propose-agent";
import type { World } from "./support/world";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captainProposalOf, isCaptainOutcome } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { agentHome } from "../src/agents/store";
import { until } from "./support/client";
import { say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const options = { captain: true, tasks: { runs: false } } as const;

function counts(w: World): {
  agents: number;
  projects: number;
  conversations: number;
} {
  const one = (sql: string) => w.host.db.query<{ n: number }, []>(sql).get()!.n;
  return {
    agents: one("SELECT COUNT(*) AS n FROM agent"),
    projects: one("SELECT COUNT(*) AS n FROM project"),
    conversations: one("SELECT COUNT(*) AS n FROM conversation"),
  };
}

const one = <T>(w: World, sql: string, id: string): T | undefined =>
  w.host.db.query<T, [string]>(sql).get(id) ?? undefined;

const agentRow = (w: World, id: string) =>
  one<{
    name: string;
    instructions: string;
    persona: string;
    runtime: string;
    model: string | null;
    machineId: string | null;
    systemRole: string | null;
  }>(
    w,
    `SELECT name, instructions, persona, runtime, model,
            machine_id AS machineId, system_role AS systemRole
       FROM agent WHERE id = ?`,
    id,
  );

const projectRow = (w: World, id: string) =>
  one<{
    machineId: string;
    path: string;
    name: string;
    kind: string;
    stewardId: string;
  }>(
    w,
    `SELECT machine_id AS machineId, path, name, kind, steward_id AS stewardId
       FROM project WHERE id = ?`,
    id,
  );

const primaryId = (w: World) =>
  w.host.db
    .query<{ id: string }, []>("SELECT id FROM machine WHERE kind = 'primary'")
    .get()!.id;

const decide = async (w: World, operationId: string, decision: string) =>
  (
    (await w.client.call("captain", "decideOperation", {
      operationId,
      decision,
    })) as { operation: CaptainOperationView }
  ).operation;

/** The proposal card Captain's tool call left in its conversation. */
const cardOf = (w: World, conversationId: string) =>
  w
    .rows(conversationId)
    .map(captainProposalOf<CaptainAgentProposal>)
    .find((card) => card?.kind === "create_agent");

/** The message that told Captain how its agent proposal ended, as the conversation shows it. */
const outcomeOf = (w: World, conversationId: string) =>
  w.rows(conversationId).find(isCaptainOutcome);

/** A host with Captain and Ada, and Captain's agent proposals made through the service. */
async function setup(models?: ReturnType<typeof scriptedModels>["models"]) {
  const w = await world({ ...options, ...(models ? { models } : {}) });
  const ada = await w.agent("Ada");
  const { conversationId: captain } = await w.host.product.captain.direct();
  await w.watch(captain);
  const captainId = w.host.product.captain.identity()!.agentId;
  const propose = (fields: Partial<AgentProposalInput> = {}) =>
    w.host.product.captain.proposals.propose(
      w.host.product.captain.propose.agent,
      {
        name: "Scout",
        purpose: "Watch the repository and say what changed.",
        instructions:
          "Watch the repository and report what changed each morning.",
        persona: "Executor",
        model: "openai:gpt-5",
        ...fields,
      },
      captain,
    );
  return { w, ada, captain, captainId, propose };
}

describe("propose_agent is Captain's", () => {
  it("is offered to Captain's session and to no other agent's", async () => {
    const { models, requests } = scriptedModels(() => say("Hello."));
    const { w, ada, captain } = await setup(models);
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id]);
    await w.watch(group.id);
    for (const id of [group.id, captain]) {
      const sent = await w.send(id, "Hi");
      await w.settled(id, sent.replies[0]!.id);
    }
    const tools = (agent: string) =>
      requests.find((request) => request.agent === agent)!.tools;
    expect(tools("Captain")).toContain("propose_agent");
    expect(tools("Captain")).toContain("list_persona_cards");
    expect(tools("Ada")).not.toContain("propose_agent");
    expect(tools("Ada")).not.toContain("list_persona_cards");
  });

  it("is always recorded in Captain's name", async () => {
    const { captainId, propose } = await setup();
    // Who proposed is not a caller's argument: the mechanism records the Captain this host has.
    const { operation } = await propose();
    expect(operation.actorAgentId).toBe(captainId);
  });
});

describe("the cards a proposal may wear", () => {
  it("are the built-in ones and the user's own, and one is worn by its id, not written", async () => {
    const { w, captain, propose } = await setup();
    const dir = join(w.host.dataDir, ".eta", "persona");
    await mkdir(dir, { recursive: true });
    const body = "# Reviewer\n\nReads a change and says what it breaks.\n";
    await writeFile(join(dir, "reviewer.persona.md"), body);

    const cards = await w.host.product.captain.listPersonaCards();
    const ids = cards.map((card) => card.id);
    expect(ids).toContain("Executor");
    expect(ids).toContain("reviewer");
    // The one line a chooser reads is the card's first line.
    expect(cards.find((card) => card.id === "reviewer")).toEqual({
      id: "reviewer",
      summary: "Reviewer",
    });

    const before = await readdir(dir);
    const { operation } = await propose({ persona: "reviewer" });
    expect(operation.payload).toMatchObject({ persona: "reviewer" });
    // The proposal carries the card's name, never its words: the body is read again when it is made.
    expect(operation.payload).not.toHaveProperty("personaContent");
    expect(w.host.product.captain.store.operation(operation.id)).toMatchObject({
      kind: "create_agent",
      status: "pending",
    });
    await until(() => cardOf(w, captain) !== undefined);
    expect(cardOf(w, captain)?.operationId).toBe(operation.id);

    const decided = await decide(w, operation.id, "approve");
    expect(decided.status).toBe("applied");
    const { agentId } = decided.result as { agentId: string };
    // The id, not the body: a session finds the card by it.
    expect(agentRow(w, agentId)?.persona).toBe("reviewer");
    // The card itself is untouched, and no card was written for the agent.
    expect(await readdir(dir)).toEqual(before);
  });
});

describe("an agent Captain proposes", () => {
  it("is only a card until the user creates it; then the agent and its workspace exist", async () => {
    const { w, captain, propose } = await setup();
    const start = counts(w);
    const { operation, messageId } = await propose();
    expect(counts(w)).toEqual(start);
    expect(operation).toMatchObject({
      kind: "create_agent",
      status: "pending",
    });

    await until(() => cardOf(w, captain) !== undefined);
    const card = cardOf(w, captain)!;
    expect(card.operationId).toBe(operation.id);
    expect(card.proposal.messageId).toBe(messageId);
    expect(card.proposal).toMatchObject({
      name: "Scout",
      purpose: "Watch the repository and say what changed.",
      instructions:
        "Watch the repository and report what changed each morning.",
      persona: "Executor",
      model: "openai:gpt-5",
      runtime: "eta",
      plugins: [],
      originConversationId: captain,
    });
    // The card and the Captain panel's list are the same record.
    expect(w.host.product.captain.store.operation(operation.id)).toMatchObject({
      kind: "create_agent",
      status: "pending",
    });

    const decided = await decide(w, operation.id, "approve");
    expect(decided.status).toBe("applied");
    const result = decided.result as {
      agentId: string;
      projectId: string;
      name: string;
    };
    expect(result.name).toBe("Scout");
    expect(agentRow(w, result.agentId)).toMatchObject({
      name: "Scout",
      instructions:
        "Watch the repository and report what changed each morning.",
      persona: "Executor",
      runtime: "eta",
      model: "openai:gpt-5",
      machineId: null,
      // Not Captain's: a proposal may not make a system role.
      systemRole: null,
    });
    expect(projectRow(w, result.projectId)).toMatchObject({
      machineId: primaryId(w),
      path: agentHome(w.host.dataDir, result.agentId),
      name: "Scout",
      kind: "agent_home",
      stewardId: result.agentId,
    });
    expect(
      (await stat(agentHome(w.host.dataDir, result.agentId))).isDirectory(),
    ).toBe(true);
    expect(counts(w)).toEqual({
      ...start,
      agents: start.agents + 1,
      projects: start.projects + 1,
    });

    // Its instructions and its persona start their histories, as the agent dialog's do.
    const history = w.host.product.captain.store.promptHistory({
      subjectId: result.agentId,
    });
    expect(history.map((version) => version.kind).sort()).toEqual([
      "instructions",
      "persona",
    ]);
    expect(
      w.host.product.captain.store.latestPrompt(result.agentId, "instructions")
        ?.content,
    ).toBe("Watch the repository and report what changed each morning.");
    expect(
      w.host.product.captain.store.latestPrompt(result.agentId, "persona")
        ?.content,
    ).toBe("Executor");
  });

  it("makes nothing when rejected", async () => {
    const { w, propose } = await setup();
    const start = counts(w);
    const { operation } = await propose();
    expect((await decide(w, operation.id, "reject")).status).toBe("rejected");
    expect(counts(w)).toEqual(start);
    expect(w.host.product.captain.store.operation(operation.id)).toMatchObject({
      status: "rejected",
    });
    await expect(decide(w, operation.id, "approve")).rejects.toThrow(
      /rejected/,
    );
    expect(counts(w)).toEqual(start);
  });

  it("stops the confirmation when an agent of that name appeared in the meantime", async () => {
    const { w, propose } = await setup();
    const { operation } = await propose();
    await w.agent("Scout");
    const start = counts(w);
    const decided = await decide(w, operation.id, "approve");
    expect(decided).toMatchObject({ status: "failed" });
    expect(decided.error).toMatch(/already exists/);
    expect(counts(w)).toEqual(start);
  });

  it("cannot be made to carry a system role", async () => {
    const { w, captainId, propose } = await setup();
    const { operation } = await propose();
    const forged = w.host.product.captain.createOperation({
      kind: "create_agent",
      requiresApproval: true,
      actorAgentId: captainId,
      payload: { ...operation.payload, systemRole: "captain" },
    });
    const decided = await decide(w, forged.id, "approve");
    expect(decided).toMatchObject({ status: "failed" });
    expect(decided.error).toContain("system role");
  });
});

describe("how a decided proposal reaches Captain", () => {
  it("tells Captain the agent was created, with what it needs to assign work", async () => {
    const { w, captain, propose } = await setup();
    const { operation } = await propose();
    // Nothing is said while it is only a card: there is no decision yet.
    expect(outcomeOf(w, captain)).toBeUndefined();

    const decided = await decide(w, operation.id, "approve");
    const { agentId, projectId } = decided.result as {
      agentId: string;
      projectId: string;
    };
    await until(() => outcomeOf(w, captain) !== undefined);
    const told = outcomeOf(w, captain)!;
    expect(told).toMatchObject({
      author: "system",
      data: {
        captainOutcome: {
          operationId: operation.id,
          kind: "create_agent",
          status: "applied",
        },
      },
    });
    expect(told.text).toContain(`agentId: ${agentId}`);
    expect(told.text).toContain(`projectId: ${projectId}`);
  });

  it("says nothing was created when the user rejected it", async () => {
    const { w, captain, propose } = await setup();
    const start = counts(w);
    const { operation } = await propose();
    expect((await decide(w, operation.id, "reject")).status).toBe("rejected");
    await until(() => outcomeOf(w, captain) !== undefined);
    const told = outcomeOf(w, captain)!;
    expect(told.data).toMatchObject({
      captainOutcome: {
        operationId: operation.id,
        kind: "create_agent",
        status: "rejected",
      },
    });
    expect(told.text).toContain("rejected");
    expect(told.text).toContain("Nothing was created");
    expect(counts(w)).toEqual(start);
  });

  it("says so when the confirmation failed, and not as a creation", async () => {
    const { w, captain, propose } = await setup();
    const { operation } = await propose();
    // An agent of that name appears between the proposal and the confirmation.
    await w.agent("Scout");
    const decided = await decide(w, operation.id, "approve");
    expect(decided.status).toBe("failed");
    await until(() => outcomeOf(w, captain) !== undefined);
    const told = outcomeOf(w, captain)!;
    expect(told.data).toMatchObject({
      captainOutcome: {
        operationId: operation.id,
        kind: "create_agent",
        status: "failed",
      },
    });
    expect(told.text).toContain("already exists");
  });

  it("says nothing about an agent the user made in the agent dialog", async () => {
    const { w, captain } = await setup();
    const before = w.rows(captain).length;
    // The dialog's create is `agents.create` on the wire: not a proposal, no operation.
    await w.agent("Scout");
    expect(w.host.product.captain.store.operations()).toEqual([]);
    expect(outcomeOf(w, captain)).toBeUndefined();
    // Nothing reached Captain's conversation at all: it was not told, and not woken.
    expect(w.rows(captain).length).toBe(before);
  });
});
describe("what a proposal is refused for", () => {
  it("refuses a name that is empty or taken, a card that is not there, and what cannot be run", async () => {
    const { w, propose } = await setup();
    await w.agent("Scout");
    const start = counts(w);
    const refused: [Partial<AgentProposalInput>, RegExp][] = [
      [{ name: "  " }, /needs a name/],
      [{ name: " scout " }, /already exists/],
      [{ purpose: "   " }, /needs a purpose/],
      [{ instructions: "  " }, /instructions must not be empty/],
      [{ persona: "Nobody" }, /no such persona card: Nobody/],
      [{ model: "" }, /needs a model/],
      [{ model: "gpt-5" }, /provider:modelId/],
      [{ runtime: "claude", model: "openai:gpt-5" }, /a claude agent runs/],
      [{ plugins: ["nope"] }, /cannot be enabled/],
    ];
    // Every case gets a name of its own, so only the name cases are about the name.
    for (const [fields, reason] of refused)
      await expect(
        propose({ name: "Another", ...fields }),
        JSON.stringify(fields),
      ).rejects.toThrow(reason);
    expect(counts(w)).toEqual(start);
    expect(w.host.product.captain.store.operations()).toEqual([]);
  });
});

describe("the persona of an agent Captain proposed", () => {
  it("is the card it was proposed with, in a real session of it", async () => {
    const { models, requests } = scriptedModels((request) =>
      say(`${request.agent} here`),
    );
    const { w, propose } = await setup(models);
    const dir = join(w.host.dataDir, ".eta", "persona");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "reviewer.persona.md"),
      "# Reviewer\n\nReads a change and says what it breaks, in one line.\n",
    );
    const { operation } = await propose({ name: "Rita", persona: "reviewer" });
    const decided = await decide(w, operation.id, "approve");
    const { agentId } = decided.result as { agentId: string };

    const project = await w.project({ stewardId: agentId });
    const group = await w.group(project.id, [agentId]);
    await w.watch(group.id);
    const sent = await w.send(group.id, "Look at this change.");
    await w.settled(group.id, sent.replies[0]!.id);

    const open = w.host.server.sessions
      .openSessions()
      .find((entry) => entry.meta.agentId === agentId)!;
    expect(open.meta.persona).toBe("reviewer");
    // Found by its id, not fallen back to the default card.
    expect(open.session.kernel.inspect().activePersonaNames).toEqual([
      "reviewer",
    ]);
    const asked = requests.find((request) => request.agent === "Rita")!;
    expect(asked.system).toContain(
      "Reads a change and says what it breaks, in one line.",
    );
  });
});
