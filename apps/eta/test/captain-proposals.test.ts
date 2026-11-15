/**
 * The proposal mechanism on its own, with a kind that is only what a kind has to bring: a check,
 * the making, and what Captain is told it made. Everything else — the operation in Captain's name,
 * the card row, the second check at confirmation, the message that tells Captain — is the
 * mechanism's, and is the same for every kind.
 */
import type {
  CaptainOperationView,
  CaptainProposalRowData,
} from "@eta/client-contracts";
import type { ProposalKind, ProposalsDeps } from "../src/captain/proposals";
import { captainProposalOf, isCaptainOutcome } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { CaptainProposals } from "../src/captain/proposals";

interface Thing {
  name: string;
  size: number;
}

/** A kind that makes nothing but a note of what it was asked to make. */
function thingKind() {
  const made: Thing[] = [];
  const state = { refuse: undefined as string | undefined };
  const kind: ProposalKind<
    { name: string; size?: number },
    Thing,
    { id: string }
  > = {
    kind: "create_thing",
    noun: "thing",
    async check(input) {
      if (state.refuse !== undefined) throw new Error(state.refuse);
      return { name: input.name.trim(), size: input.size ?? 1 };
    },
    async apply(proposal) {
      made.push(proposal);
      return { id: `thing-${made.length}` };
    },
    created: (proposal, result) => [`id: ${result.id} (${proposal.size})`],
  };
  return { kind, made, state };
}

function harness(options: { reachable?: boolean } = {}) {
  const rows: { conversationId: string; text: string; data: unknown }[] = [];
  const sent: {
    conversationId: string;
    text: string;
    data: Record<string, unknown>;
    author: string;
  }[] = [];
  const operations = new Map<string, CaptainOperationView>();
  const deps = {
    conversations: {
      get: (id: string) =>
        id === "origin" || id === "direct"
          ? { id, archived: false }
          : undefined,
      participants: () =>
        options.reachable === false ? [] : [{ agentId: "captain" }],
    },
    timeline: {
      append: (row: { conversationId: string; text: string; data: unknown }) =>
        rows.push(row),
    },
    engine: {
      send: async (message: (typeof sent)[number]) => {
        sent.push(message);
      },
    },
    changed: () => {},
    warn: (message: string) => {
      throw new Error(message);
    },
    identity: () => ({ agentId: "captain" }),
    direct: async () => ({ conversationId: "direct" }),
    createOperation: (input: {
      kind: string;
      payload?: Record<string, unknown>;
      actorAgentId?: string | null;
      requiresApproval?: boolean;
    }) => {
      const operation: CaptainOperationView = {
        id: `00000000-0000-4000-8000-00000000000${operations.size}`,
        kind: input.kind,
        actorAgentId: input.actorAgentId ?? null,
        requiresApproval: input.requiresApproval === true,
        status: "pending",
        payload: input.payload ?? {},
        result: null,
        error: null,
        createdAt: 0,
        updatedAt: 0,
      };
      operations.set(operation.id, operation);
      return operation;
    },
  } as unknown as ProposalsDeps;
  return { deps, rows, sent, operations };
}

describe("a proposal", () => {
  it("is checked, recorded in Captain's name and drawn as a card; nothing is made", async () => {
    const { kind, made } = thingKind();
    const h = harness();
    const proposals = new CaptainProposals(h.deps, [kind]);
    const { operation, messageId } = await proposals.propose(
      kind,
      { name: " Widget " },
      "origin",
    );
    expect(made).toEqual([]);
    expect(operation).toMatchObject({
      kind: "create_thing",
      actorAgentId: "captain",
      requiresApproval: true,
      status: "pending",
      payload: {
        originConversationId: "origin",
        messageId,
        name: "Widget",
        size: 1,
      },
    });
    expect(h.rows).toHaveLength(1);
    const row = h.rows[0]!;
    expect(row.conversationId).toBe("origin");
    expect(row.text).toBe(
      'Captain proposed the thing "Widget". It is made when the user confirms it.',
    );
    expect(row.data).toEqual({
      event: "captain_proposal",
      kind: "create_thing",
      operationId: operation.id,
      proposal: operation.payload,
    } satisfies CaptainProposalRowData);
    // What a client reads of the row: any kind, without knowing it.
    expect(captainProposalOf({ data: row.data as never })).toEqual({
      kind: "create_thing",
      operationId: operation.id,
      proposal: operation.payload,
    });
  });

  it("is not recorded at all when its check refuses it", async () => {
    const { kind, state } = thingKind();
    state.refuse = "no room for it";
    const h = harness();
    const proposals = new CaptainProposals(h.deps, [kind]);
    await expect(
      proposals.propose(kind, { name: "Widget" }, "origin"),
    ).rejects.toThrow(/no room for it/);
    expect(h.operations.size).toBe(0);
    expect(h.rows).toEqual([]);
  });

  it("is checked again when it is confirmed, and made from what that check says", async () => {
    const { kind, made, state } = thingKind();
    const h = harness();
    const proposals = new CaptainProposals(h.deps, [kind]);
    const { operation } = await proposals.propose(
      kind,
      { name: "Widget", size: 3 },
      "origin",
    );
    expect(proposals.handles(operation)).toBe(true);
    expect(proposals.handles({ kind: "set_prompt" })).toBe(false);
    expect(await proposals.apply(operation)).toEqual({ id: "thing-1" });
    expect(made).toEqual([{ name: "Widget", size: 3 }]);

    state.refuse = "it no longer fits";
    await expect(proposals.apply(operation)).rejects.toThrow(
      /it no longer fits/,
    );
    expect(made).toHaveLength(1);
  });

  it("tells Captain how it ended, in a message clients do not draw", async () => {
    const { kind } = thingKind();
    const h = harness();
    const proposals = new CaptainProposals(h.deps, [kind]);
    const { operation } = await proposals.propose(
      kind,
      { name: "Widget", size: 2 },
      "origin",
    );
    const ended = (
      fields: Partial<CaptainOperationView>,
    ): CaptainOperationView => ({ ...operation, ...fields });
    await proposals.settled(
      ended({ status: "applied", result: { id: "thing-1" } }),
    );
    await proposals.settled(ended({ status: "rejected" }));
    await proposals.settled(ended({ status: "failed", error: "boom" }));
    // An operation that is no proposal says nothing.
    await proposals.settled(ended({ kind: "set_prompt", status: "applied" }));

    const head = `Your proposed thing "Widget" (operation ${operation.id})`;
    expect(h.sent.map((message) => message.text)).toEqual([
      `${head} was confirmed by the user and created.\nid: thing-1 (2)`,
      `${head} was rejected by the user. Nothing was created. If one is still needed, ask what to change before proposing again.`,
      `${head} was confirmed by the user, but creating it failed: boom. Nothing was created.`,
    ]);
    for (const [index, status] of ["applied", "rejected", "failed"].entries()) {
      const message = h.sent[index]!;
      expect(message).toMatchObject({
        conversationId: "origin",
        author: "system",
        data: {
          captainOutcome: {
            operationId: operation.id,
            kind: "create_thing",
            status,
          },
        },
      });
      expect(
        isCaptainOutcome({ ...message, kind: "message", author: "system" }),
      ).toBe(true);
    }
  });

  it("tells Captain in its direct chat when it can no longer speak where it proposed", async () => {
    const { kind } = thingKind();
    const h = harness({ reachable: false });
    const proposals = new CaptainProposals(h.deps, [kind]);
    const { operation } = await proposals.propose(
      kind,
      { name: "Widget" },
      "origin",
    );
    await proposals.settled({ ...operation, status: "rejected" });
    expect(h.sent[0]?.conversationId).toBe("direct");
  });
});
