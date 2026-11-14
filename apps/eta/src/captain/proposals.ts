/**
 * What Captain proposes and the user confirms: one way for every kind of proposal.
 *
 * Proposing checks the input against what exists now and records a pending operation of the kind
 * (`create_group`, `create_agent`) whose payload is the checked proposal, plus the conversation it
 * came from and the card's row. The card is a system row in that conversation (`captain_proposal`).
 * The user answers on the card (`captain.decideOperation`); confirming checks the stored proposal
 * again, since much can change in between, and then makes it. However it ends, Captain is told in
 * the conversation it proposed from, as a message that starts its next turn and that clients do not
 * draw (`captainOutcome`).
 *
 * A kind brings only what is its own: the check, the making, and what Captain is told it made. The
 * card a client draws for it is the client's (`apps/web/.../proposal-card.tsx`).
 */
import type {
  CaptainIdentityView,
  CaptainOperationView,
  CaptainOutcomeData,
  CaptainProposalRowData,
} from "@eta/client-contracts";
import type { Engine } from "../conversations/engine";
import type { ConversationStore } from "../conversations/store";
import type { Timeline } from "../conversations/timeline";
import type { CaptainOperationRequest } from "./service";
import { CAPTAIN_PROPOSAL_EVENT } from "@eta/client-contracts";

/** The two fields every stored proposal has besides its kind's own. */
export interface ProposalOrigin {
  /** Where Captain proposed it: the card is there, and so is the message that tells Captain. */
  originConversationId: string;
  /** The card's row in that conversation. */
  messageId: string;
}

export interface ProposalKind<
  Input,
  Proposal extends { name: string },
  Result extends object,
> {
  /** The operation's kind. Stored with every operation, so it is never renamed. */
  readonly kind: string;
  /** What Captain reads it as: `group`, `agent`. */
  readonly noun: string;
  /**
   * Whether it could be made as things are now, and what exactly would be made: throws saying why
   * not. The same check runs when it is proposed and again when the user confirms it.
   */
  check: (input: Input) => Promise<Proposal>;
  /** A stored proposal as the input `check` takes again; the proposal itself when left out. */
  again?: (proposal: Proposal) => Input;
  /** Make the checked proposal. `operation.actorAgentId` is Captain. */
  apply: (
    proposal: Proposal,
    operation: CaptainOperationView,
  ) => Promise<Result>;
  /** What Captain is told it made, after the line that says it was created. */
  created: (proposal: Proposal, result: Result) => string[];
}

/**
 * Any kind, once registered: the mechanism only passes what one of its functions returns to the
 * next, so the kind's own types no longer matter.
 */
type AnyKind = ProposalKind<unknown, { name: string }, object>;

export interface ProposalsDeps {
  conversations: ConversationStore;
  timeline: Timeline;
  engine: Engine;
  changed: (conversationIds?: readonly string[]) => void;
  warn: (message: string) => void;
  identity: () => CaptainIdentityView | undefined;
  /** Captain's direct chat, where it hears an outcome it cannot hear where it proposed. */
  direct: () => Promise<{ conversationId: string }>;
  createOperation: (input: CaptainOperationRequest) => CaptainOperationView;
}

export class CaptainProposals {
  readonly #deps: ProposalsDeps;
  readonly #kinds: Map<string, AnyKind>;

  constructor(deps: ProposalsDeps, kinds: readonly Pick<AnyKind, "kind">[]) {
    this.#deps = deps;
    this.#kinds = new Map(kinds.map((kind) => [kind.kind, kind as AnyKind]));
  }

  /**
   * Propose: nothing is made. The proposal is checked, recorded as a pending operation of its kind
   * in Captain's name, and drawn as a card in the conversation it came from.
   */
  async propose<
    Input,
    Proposal extends { name: string },
    Result extends object,
  >(
    kind: ProposalKind<Input, Proposal, Result>,
    input: Input,
    originConversationId: string,
  ): Promise<{ operation: CaptainOperationView; messageId: string }> {
    // Who proposes is not a caller's argument: it is always the Captain this host has.
    const captain = this.#deps.identity();
    if (captain === undefined) throw new Error("Captain is not initialized");
    const origin = this.#deps.conversations.get(originConversationId);
    if (origin === undefined) throw new Error("no such conversation");
    const checked = await kind.check(input);
    const messageId = crypto.randomUUID();
    const proposal = {
      originConversationId: origin.id,
      messageId,
      ...checked,
    } satisfies ProposalOrigin;
    const operation = this.#deps.createOperation({
      kind: kind.kind,
      requiresApproval: true,
      actorAgentId: captain.agentId,
      payload: { ...proposal },
    });
    const data: CaptainProposalRowData = {
      event: CAPTAIN_PROPOSAL_EVENT,
      kind: kind.kind,
      operationId: operation.id,
      proposal,
    };
    this.#deps.timeline.append({
      id: messageId,
      conversationId: origin.id,
      kind: "system",
      author: "system",
      text: `Captain proposed the ${kind.noun} "${checked.name}". It is made when the user confirms it.`,
      data: { ...data },
    });
    this.#deps.changed([origin.id]);
    return { operation, messageId };
  }

  /** Whether an operation is a proposal of a kind this host knows. */
  handles(operation: Pick<CaptainOperationView, "kind">): boolean {
    return this.#kinds.has(operation.kind);
  }

  /** The confirmed proposal, checked again and made. Throws, saying why, when it cannot be. */
  async apply(
    operation: CaptainOperationView,
  ): Promise<Record<string, unknown>> {
    const kind = this.#kinds.get(operation.kind);
    if (kind === undefined)
      throw new Error(`unsupported Captain operation: ${operation.kind}`);
    const stored = operation.payload as { name: string };
    const checked = await kind.check(kind.again?.(stored) ?? stored);
    const result = await kind.apply(checked, operation);
    this.#deps.changed();
    return { ...result };
  }

  /**
   * A decided proposal: Captain hears the outcome in the conversation it proposed from, as a message
   * that starts its next turn. Any other operation is not a proposal, and nothing is said about it.
   */
  async settled(operation: CaptainOperationView): Promise<void> {
    const kind = this.#kinds.get(operation.kind);
    if (kind === undefined) return;
    const captain = this.#deps.identity();
    if (captain === undefined) return;
    try {
      const conversationId = await this.#outcomeConversation(
        String(operation.payload.originConversationId ?? ""),
        captain.agentId,
      );
      await this.#deps.engine.send({
        conversationId,
        text: outcomeText(kind, operation),
        author: "system",
        // Captain's context, not the user's: the card already shows how it ended.
        data: {
          captainOutcome: {
            operationId: operation.id,
            kind: operation.kind,
            status: operation.status,
          } satisfies CaptainOutcomeData,
        },
        mentions: [captain.agentId],
        mode: "queue",
      });
      this.#deps.changed([conversationId]);
    } catch (error) {
      this.#deps.warn(
        `[eta] Captain was not told how its ${kind.noun} proposal ended: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Where Captain hears how a proposal ended: the conversation it proposed from, or its direct
   * chat when it can no longer speak there (archived, or it is not a member any more).
   */
  async #outcomeConversation(
    originConversationId: string,
    captainAgentId: string,
  ): Promise<string> {
    const origin = this.#deps.conversations.get(originConversationId);
    const reachable =
      origin !== undefined &&
      !origin.archived &&
      this.#deps.conversations
        .participants(origin.id)
        .some((member) => member.agentId === captainAgentId);
    return reachable ? origin.id : (await this.#deps.direct()).conversationId;
  }
}

/**
 * What Captain is told when the user decided on something it proposed. A group's opening is the one
 * clients matched before the outcome carried a mark (`isCaptainOutcome`), so it must not change.
 */
function outcomeText(kind: AnyKind, operation: CaptainOperationView): string {
  const proposal = operation.payload as { name: string };
  const head = `Your proposed ${kind.noun} "${proposal.name}" (operation ${operation.id})`;
  if (operation.status === "applied")
    return [
      `${head} was confirmed by the user and created.`,
      ...kind.created(proposal, operation.result ?? {}),
    ].join("\n");
  if (operation.status === "rejected")
    return `${head} was rejected by the user. Nothing was created. If one is still needed, ask what to change before proposing again.`;
  return `${head} was confirmed by the user, but creating it failed: ${operation.error ?? "unknown error"}. Nothing was created.`;
}
