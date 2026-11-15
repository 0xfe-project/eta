import type {
  CaptainRoutineProposal,
  CaptainRoutineResult,
} from "@eta/client-contracts";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ProposalField, ProposalFields } from "./proposal-fields";
import { describeSchedule } from "./routine-format";
import { useSectionLink } from "./workspace-search";

/**
 * A routine Captain proposed from a chat: its schedule, its zone and the brief each run is given.
 * It names no agent and no model, because it is Captain's; where its reports go is in the brief.
 */
export function RoutineProposalDetails({
  proposal,
}: {
  proposal: CaptainRoutineProposal;
}) {
  const { t } = useTranslation(["captain"] as const);
  return (
    <ProposalFields>
      <ProposalField label={t("routineProposal.schedule")}>
        {describeSchedule(proposal.schedule)}
      </ProposalField>
      <ProposalField label={t("routineProposal.timezone")}>
        {proposal.timezone}
      </ProposalField>
      <ProposalField label={t("routineProposal.brief")}>
        <span className="whitespace-pre-wrap">{proposal.brief}</span>
      </ProposalField>
    </ProposalFields>
  );
}

/** Once made: the way to it on the routines page. */
export function RoutineReady({ result }: { result: CaptainRoutineResult }) {
  const { t } = useTranslation(["captain"] as const);
  const sectionLink = useSectionLink();
  return (
    <p className="text-xs">
      <Link
        {...sectionLink("routines", { routine: result.routineId })}
        className="underline underline-offset-4"
      >
        {t("routineProposal.open", { name: result.name })}
      </Link>
    </p>
  );
}
