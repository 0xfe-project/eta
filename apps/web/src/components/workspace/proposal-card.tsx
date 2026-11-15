import type {
  CaptainOperationStatus,
  CaptainProposalRow,
  MessageView,
} from "@eta/client-contracts";
import type { Icon } from "@phosphor-icons/react";
import type { ComponentType, ReactNode } from "react";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { UsersThreeIcon } from "@phosphor-icons/react/UsersThree";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useCaptain, useCaptainActions } from "@/queries/captain";
import { wireErrorMessage } from "@/queries/wire";
import { AgentProposalDetails, AgentReady } from "./agent-proposal-card";
import { GroupProposalDetails, OpenGroup } from "./group-proposal-card";
import { StateMark } from "./state-mark";

/**
 * What a kind of proposal draws of its own: its icon and words, what it would make, and what it
 * made. The rest of the card — the status, the two answers, the error — is the same for every kind.
 */
interface ProposalCardKind<P, R> {
  icon: Icon;
  /** `captain` keys: the card's heading, and its accessible name (`{{name}}`). */
  title: string;
  label: string;
  Details: ComponentType<{ proposal: P }>;
  /** Shown once it was made. */
  Done?: ComponentType<{ proposal: P; result: R }>;
}

/** A kind, as the shared card takes it: the props are the kind's own business. */
type AnyCardKind = ProposalCardKind<never, never>;

const card = <P, R>(kind: ProposalCardKind<P, R>) =>
  kind as unknown as AnyCardKind;

/** The card each operation kind draws. A kind this page does not know is drawn as its row's text. */
const CARDS: Record<string, AnyCardKind> = {
  create_group: card({
    icon: UsersThreeIcon,
    title: "proposal.title",
    label: "proposal.label",
    Details: GroupProposalDetails,
    Done: OpenGroup,
  }),
  create_agent: card({
    icon: RobotIcon,
    title: "agentProposal.title",
    label: "agentProposal.label",
    Details: AgentProposalDetails,
    Done: AgentReady,
  }),
};

/**
 * Something Captain proposed, in the conversation it proposed it from: what it would be, and the two
 * answers. Nothing exists until "Create"; not satisfied, the reader rejects it and Captain proposes
 * again, so nothing on the card is editable.
 *
 * The state is the operation's, the same record the operations list in Captain's panel shows. An
 * operation too old to be in that list leaves the proposal with no state and nothing to press.
 */
export function ProposalCard({
  message,
  row,
}: {
  message: MessageView;
  row: CaptainProposalRow;
}) {
  const { t: translateText } = useTranslation(["captain", "common"] as const);
  const captain = useCaptain();
  const actions = useCaptainActions();
  const kind = CARDS[row.kind];
  if (kind === undefined)
    return (
      <div className="system-message">
        <p>{message.text}</p>
      </div>
    );
  const proposal = row.proposal as never;
  const name = String(row.proposal.name ?? "");
  const operation = captain.operations.find(
    (item) => item.id === row.operationId,
  );
  const status = operation?.status;
  const deciding = actions.decideOperation.isPending;
  const { icon: KindIcon, Details, Done } = kind;

  const decide = (decision: "approve" | "reject") => {
    void actions.decideOperation
      .mutateAsync({ operationId: row.operationId, decision })
      .catch((failure: Error) => toast.error(wireErrorMessage(failure)));
  };

  let outcome: ReactNode = null;
  if (status === "applied" && operation?.result != null && Done !== undefined)
    outcome = <Done proposal={proposal} result={operation.result as never} />;
  else if (status === "failed" && operation?.error != null)
    outcome = (
      <p role="alert" className="text-xs wrap-anywhere">
        {operation.error}
      </p>
    );

  return (
    <section
      className="task-fold w-full self-start"
      aria-label={translateText(kind.label as never, { name })}
    >
      <div className="flex items-center gap-2 px-2.5 py-[5px] font-mono text-[10px] tracking-[0.08em] text-faint uppercase">
        <KindIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="shrink-0">{translateText(kind.title as never)}</span>
        <span className="task-fold-title">{name}</span>
        {status === undefined ? null : <OperationStatusMark status={status} />}
      </div>
      <div className="task-fold-body">
        <Details proposal={proposal} />
        {status === "pending" ? (
          <div className="flex gap-2">
            <Button
              type="button"
              size="xs"
              disabled={deciding}
              onClick={() => decide("approve")}
            >
              {translateText("proposal.create")}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={deciding}
              onClick={() => decide("reject")}
            >
              {translateText("proposal.reject")}
            </Button>
          </div>
        ) : null}
        {outcome}
      </div>
    </section>
  );
}

/**
 * Where a proposed operation stands, at the right end of its line: a square and a word. Waiting for
 * you to press Create is not a warning, so it is grey; only the outcome has a colour — created, or
 * failed.
 */
function OperationStatusMark({ status }: { status: CaptainOperationStatus }) {
  const { t: translateText } = useTranslation(["captain"] as const);
  return (
    <StateMark
      tone={
        status === "applied"
          ? "success"
          : status === "failed"
            ? "error"
            : "neutral"
      }
      className="ml-auto shrink-0 text-muted-foreground"
    >
      {translateText(`proposal.status.${status}`)}
    </StateMark>
  );
}
