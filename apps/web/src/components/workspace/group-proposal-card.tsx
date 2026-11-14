import type {
  CaptainGroupProposalRowData,
  CaptainGroupResult,
  MessageView,
} from "@eta/client-contracts";
import { UsersThreeIcon } from "@phosphor-icons/react/UsersThree";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { agentName, useAgentList } from "@/queries/agents";
import { useCaptain, useCaptainActions } from "@/queries/captain";
import { useMachines } from "@/queries/projects";
import { wireErrorMessage } from "@/queries/wire";
import { OperationStatusMark } from "./proposal-status";

/**
 * A group Captain proposed, in the conversation it proposed it from: what it would be, and the two
 * answers. Nothing exists until "Create"; not satisfied, the reader rejects it and Captain proposes
 * again, so nothing on the card is editable.
 *
 * The state is the operation's, the same record the operations list in Captain's panel shows. An
 * operation too old to be in that list leaves the proposal with no state and nothing to press.
 */
export function GroupProposalCard({ message }: { message: MessageView }) {
  const { t: translateText } = useTranslation(["captain", "common"] as const);
  const { agents } = useAgentList();
  const { machines } = useMachines();
  const captain = useCaptain();
  const actions = useCaptainActions();
  const data = message.data as unknown as CaptainGroupProposalRowData;
  const { proposal } = data;
  const operation = captain.operations.find(
    (item) => item.id === data.operationId,
  );
  const status = operation?.status;
  const result = operation?.result as CaptainGroupResult | null | undefined;
  const error = operation?.error;
  const machine = machines.find((item) => item.id === proposal.machineId);
  const deciding = actions.decideOperation.isPending;

  const decide = (decision: "approve" | "reject") => {
    void actions.decideOperation
      .mutateAsync({ operationId: data.operationId, decision })
      .catch((failure: Error) => toast.error(wireErrorMessage(failure)));
  };

  const where =
    machine === undefined || machine.kind === "primary"
      ? proposal.path
      : `${machine.name}:${proposal.path}`;

  return (
    <section
      className="task-fold w-full self-start"
      aria-label={translateText("proposal.label", { name: proposal.name })}
    >
      <div className="flex items-center gap-2 px-2.5 py-[5px] font-mono text-[10px] tracking-[0.08em] text-faint uppercase">
        <UsersThreeIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="shrink-0">{translateText("proposal.title")}</span>
        <span className="task-fold-title">{proposal.name}</span>
        {status === undefined ? null : (
          <OperationStatusMark
            status={status}
            label={translateText(`proposal.status.${status}`)}
          />
        )}
      </div>
      <div className="task-fold-body">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">
            {translateText("proposal.directory")}
          </dt>
          <dd className="min-w-0">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium wrap-anywhere">
                {proposal.projectName}
              </span>
              {proposal.projectId === null ? (
                <Badge variant="outline" className="h-4 px-1 text-[10px]">
                  {translateText("proposal.newProject")}
                </Badge>
              ) : null}
            </span>
            <span className="block font-mono text-[11px] break-all text-muted-foreground">
              {where}
            </span>
          </dd>
          <dt className="text-muted-foreground">
            {translateText("proposal.members")}
          </dt>
          <dd className="min-w-0 wrap-anywhere">
            {proposal.memberIds.map((id) => agentName(agents, id)).join(", ")}
          </dd>
          <dt className="text-muted-foreground">
            {translateText("proposal.steward")}
          </dt>
          <dd className="min-w-0 wrap-anywhere">
            {agentName(agents, proposal.stewardId)}
          </dd>
          {proposal.goal === null ? null : (
            <>
              <dt className="text-muted-foreground">
                {translateText("proposal.goal")}
              </dt>
              <dd className="min-w-0 wrap-anywhere">{proposal.goal}</dd>
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
        {status === "applied" && result != null ? (
          <Link
            to="/"
            search={{ group: result.conversationId }}
            className="w-fit text-xs underline-offset-4 hover:underline"
          >
            {translateText("proposal.open", { name: proposal.name })}
          </Link>
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
