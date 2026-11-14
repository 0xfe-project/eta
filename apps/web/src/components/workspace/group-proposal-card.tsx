import type {
  CaptainGroupProposal,
  CaptainGroupResult,
} from "@eta/client-contracts";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { agentName, useAgentList } from "@/queries/agents";
import { useMachines } from "@/queries/projects";
import { ProposalField, ProposalFields } from "./proposal-fields";

/** A group Captain proposed: where it goes and who is in it; once made, the way to it. */
export function GroupProposalDetails({
  proposal,
}: {
  proposal: CaptainGroupProposal;
}) {
  const { t: translateText } = useTranslation(["captain"] as const);
  const { agents } = useAgentList();
  const { machines } = useMachines();
  const machine = machines.find((item) => item.id === proposal.machineId);
  const where =
    machine === undefined || machine.kind === "primary"
      ? proposal.path
      : `${machine.name}:${proposal.path}`;
  return (
    <ProposalFields>
      <ProposalField label={translateText("proposal.directory")}>
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
      </ProposalField>
      <ProposalField label={translateText("proposal.members")}>
        {proposal.memberIds.map((id) => agentName(agents, id)).join(", ")}
      </ProposalField>
      <ProposalField label={translateText("proposal.steward")}>
        {agentName(agents, proposal.stewardId)}
      </ProposalField>
      {proposal.goal === null ? null : (
        <ProposalField label={translateText("proposal.goal")}>
          {proposal.goal}
        </ProposalField>
      )}
    </ProposalFields>
  );
}

export function OpenGroup({
  proposal,
  result,
}: {
  proposal: CaptainGroupProposal;
  result: CaptainGroupResult;
}) {
  const { t: translateText } = useTranslation(["captain"] as const);
  return (
    <Link
      to="/"
      search={{ group: result.conversationId }}
      className="w-fit text-xs underline-offset-4 hover:underline"
    >
      {translateText("proposal.open", { name: proposal.name })}
    </Link>
  );
}
