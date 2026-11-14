import type {
  CaptainAgentProposalRowData,
  CaptainAgentResult,
  MessageView,
} from "@eta/client-contracts";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useCaptain, useCaptainActions } from "@/queries/captain";
import { useMachines } from "@/queries/projects";
import { wireErrorMessage } from "@/queries/wire";
import { OperationStatusMark } from "./proposal-status";

/**
 * An agent Captain proposed, in the conversation it proposed it from: what it would be and what it
 * would wear, and the two answers. Nothing exists until "Create"; not satisfied, the reader rejects
 * it and Captain proposes again, so nothing on the card is editable.
 *
 * The persona is one of the cards that already exist — the id on the card is the card's own name, and
 * its text becomes the agent's persona — and the model is the one the user picked, so both are shown
 * rather than chosen here.
 *
 * The state is the operation's, the same record the operations list in Captain's panel shows. An
 * operation too old to be in that list leaves the proposal with no state and nothing to press.
 */
export function AgentProposalCard({ message }: { message: MessageView }) {
  const { t: translateText } = useTranslation(["captain", "common"] as const);
  const { machines } = useMachines();
  const captain = useCaptain();
  const actions = useCaptainActions();
  const data = message.data as unknown as CaptainAgentProposalRowData;
  const { proposal } = data;
  const operation = captain.operations.find(
    (item) => item.id === data.operationId,
  );
  const status = operation?.status;
  const result = operation?.result as CaptainAgentResult | null | undefined;
  const error = operation?.error;
  // An agent is only made on the primary machine, so that is what the card names when the proposal
  // did not pin one.
  const machine =
    machines.find((item) => item.id === proposal.machineId) ??
    machines.find((item) => item.kind === "primary");
  const deciding = actions.decideOperation.isPending;

  const decide = (decision: "approve" | "reject") => {
    void actions.decideOperation
      .mutateAsync({ operationId: data.operationId, decision })
      .catch((failure: Error) => toast.error(wireErrorMessage(failure)));
  };

  return (
    <section
      className="task-fold w-full self-start"
      aria-label={translateText("agentProposal.label", { name: proposal.name })}
    >
      <div className="flex items-center gap-2 px-2.5 py-[5px] font-mono text-[10px] tracking-[0.08em] text-faint uppercase">
        <RobotIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="shrink-0">{translateText("agentProposal.title")}</span>
        <span className="task-fold-title">{proposal.name}</span>
        {status === undefined ? null : (
          <OperationStatusMark
            status={status}
            label={translateText(`agentProposal.status.${status}`)}
          />
        )}
      </div>
      <div className="task-fold-body">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">
            {translateText("agentProposal.purpose")}
          </dt>
          <dd className="min-w-0 wrap-anywhere">{proposal.purpose}</dd>
          <dt className="text-muted-foreground">
            {translateText("agentProposal.persona")}
          </dt>
          <dd className="min-w-0 wrap-anywhere font-mono text-[11px]">
            {proposal.persona}
          </dd>
          <dt className="text-muted-foreground">
            {translateText("agentProposal.model")}
          </dt>
          <dd className="min-w-0 wrap-anywhere font-mono text-[11px]">
            {proposal.model}
          </dd>
          <dt className="text-muted-foreground">
            {translateText("agentProposal.runtime")}
          </dt>
          <dd className="min-w-0 wrap-anywhere">{proposal.runtime}</dd>
          <dt className="text-muted-foreground">
            {translateText("agentProposal.machine")}
          </dt>
          <dd className="min-w-0 wrap-anywhere">
            {machine?.name ?? proposal.machineId}
          </dd>
          {proposal.plugins.length === 0 ? null : (
            <>
              <dt className="text-muted-foreground">
                {translateText("agentProposal.plugins")}
              </dt>
              <dd className="min-w-0 wrap-anywhere">
                {proposal.plugins.join(", ")}
              </dd>
            </>
          )}
        </dl>
        {status === "pending" ? (
          <div className="flex gap-2">
            <Button
              type="button"
              size="xs"
              disabled={deciding}
              onClick={() => decide("approve")}
            >
              {translateText("agentProposal.create")}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={deciding}
              onClick={() => decide("reject")}
            >
              {translateText("agentProposal.reject")}
            </Button>
          </div>
        ) : null}
        {status === "applied" && result != null ? (
          <p className="text-xs wrap-anywhere">
            {translateText("agentProposal.created", { name: result.name })}
          </p>
        ) : null}
        {status === "failed" && error !== null ? (
          <p role="alert" className="text-xs wrap-anywhere">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
