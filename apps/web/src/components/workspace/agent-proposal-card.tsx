import type {
  CaptainAgentProposal,
  CaptainAgentResult,
} from "@eta/client-contracts";
import { useTranslation } from "react-i18next";
import { ProposalField, ProposalFields } from "./proposal-fields";

/**
 * An agent Captain proposed: what it is for, the card it would wear and the model the user picked —
 * both shown rather than chosen here. It is made on the primary machine.
 */
export function AgentProposalDetails({
  proposal,
}: {
  proposal: CaptainAgentProposal;
}) {
  const { t: translateText } = useTranslation(["captain"] as const);
  return (
    <ProposalFields>
      <ProposalField label={translateText("agentProposal.purpose")}>
        {proposal.purpose}
      </ProposalField>
      <ProposalField label={translateText("agentProposal.persona")} mono>
        {proposal.persona}
      </ProposalField>
      <ProposalField label={translateText("agentProposal.model")} mono>
        {proposal.model}
      </ProposalField>
      <ProposalField label={translateText("agentProposal.runtime")}>
        {proposal.runtime}
      </ProposalField>
      {proposal.plugins.length === 0 ? null : (
        <ProposalField label={translateText("agentProposal.plugins")}>
          {proposal.plugins.join(", ")}
        </ProposalField>
      )}
    </ProposalFields>
  );
}

export function AgentReady({ result }: { result: CaptainAgentResult }) {
  const { t: translateText } = useTranslation(["captain"] as const);
  return (
    <p className="text-xs wrap-anywhere">
      {translateText("agentProposal.created", { name: result.name })}
    </p>
  );
}
