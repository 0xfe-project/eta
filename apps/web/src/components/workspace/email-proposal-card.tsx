import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { PaperPlaneRightIcon } from "@phosphor-icons/react/PaperPlaneRight";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  useConfirmEmailProposal,
  useDiscardEmailProposal,
  useEmail,
} from "@/queries/email";
import { wireErrorMessage } from "@/queries/wire";

export function EmailProposalCard({ proposalId }: { proposalId: string }) {
  const { proposals } = useEmail();
  const proposal = proposals.find((item) => item.id === proposalId);
  if (!proposal) return null;
  return (
    <ProposalForm
      key={`${proposal.id}:${proposal.updatedAt}:${proposal.status}`}
      proposalId={proposalId}
    />
  );
}

function ProposalForm({ proposalId }: { proposalId: string }) {
  const { t } = useTranslation(["email", "common"] as const);
  const { proposals } = useEmail();
  const proposal = proposals.find((item) => item.id === proposalId)!;
  const [to, setTo] = useState(proposal.to);
  const [subject, setSubject] = useState(proposal.subject);
  const [markdown, setMarkdown] = useState(proposal.markdown);
  const confirm = useConfirmEmailProposal();
  const discard = useDiscardEmailProposal();
  const [expanded, setExpanded] = useState(
    () =>
      proposal.status === "pending" ||
      proposal.status === "sending" ||
      proposal.status === "failed",
  );
  const closed =
    proposal.status === "accepted" ||
    proposal.status === "discarded" ||
    proposal.status === "sending";
  const statusLabel =
    proposal.status === "pending"
      ? t("proposal.status.pending")
      : proposal.status === "sending"
        ? t("proposal.status.sending")
        : proposal.status === "accepted"
          ? t("proposal.status.accepted")
          : proposal.status === "failed"
            ? t("proposal.status.failed")
            : t("proposal.status.discarded");
  const collapsedHint = closed
    ? proposal.status === "accepted"
      ? t("proposal.collapsed.accepted")
      : proposal.status === "sending"
        ? t("proposal.collapsed.sending")
        : t("proposal.collapsed.discarded")
    : t("proposal.collapsed.pending");
  return (
    <section
      className="border bg-background p-3"
      aria-label={t("proposal.title")}
    >
      <button
        type="button"
        className="mb-3 flex w-full items-center gap-2 text-left"
        aria-expanded={expanded}
        aria-controls={expanded ? `email-proposal-${proposalId}` : undefined}
        onClick={() => setExpanded((current) => !current)}
      >
        <PaperPlaneRightIcon aria-hidden="true" className="size-4" />
        <span className="text-sm font-semibold">
          {proposal.kind === "reply" ? t("proposal.reply") : t("proposal.new")}
        </span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {statusLabel}
        </span>
        <CaretDownIcon
          aria-hidden="true"
          className={`size-4 text-muted-foreground transition-transform duration-[60ms] ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {expanded ? (
        <div id={`email-proposal-${proposalId}`}>
          <div className="grid gap-2">
            <Label className="grid grid-cols-[3rem_minmax(0,1fr)] items-center gap-1">
              <span className="shrink-0 whitespace-nowrap text-right">
                {t("thread.to")}
              </span>
              <Input
                value={to}
                disabled={closed}
                onChange={(event) => setTo(event.target.value)}
              />
            </Label>
            <Label className="grid grid-cols-[3rem_minmax(0,1fr)] items-center gap-1">
              <span className="shrink-0 whitespace-nowrap text-right">
                {t("proposal.subject")}
              </span>
              <Input
                value={subject}
                disabled={closed}
                onChange={(event) => setSubject(event.target.value)}
              />
            </Label>
            <Label className="grid grid-cols-[3rem_minmax(0,1fr)] items-start gap-1">
              <span className="shrink-0 whitespace-nowrap text-right">
                {t("proposal.body")}
              </span>
              <Textarea
                className="min-h-28 font-mono text-xs"
                value={markdown}
                disabled={closed}
                onChange={(event) => setMarkdown(event.target.value)}
              />
            </Label>
          </div>
          {proposal.error ? (
            <p className="mt-2 text-xs text-destructive">{proposal.error}</p>
          ) : null}
          <div className="mt-3 flex justify-end gap-2">
            {proposal.status === "pending" || proposal.status === "failed" ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={discard.isPending}
                  onClick={() =>
                    discard.mutate(
                      { proposalId },
                      {
                        onError: (error) =>
                          toast.error(wireErrorMessage(error)),
                      },
                    )
                  }
                >
                  <TrashIcon />
                  {t("proposal.discard")}
                </Button>
                <Button
                  size="sm"
                  disabled={confirm.isPending || !to.trim() || !subject.trim()}
                  onClick={() =>
                    confirm.mutate(
                      { proposalId, to, subject, markdown },
                      {
                        onSuccess: () => toast.success(t("proposal.sent")),
                        onError: (error) =>
                          toast.error(wireErrorMessage(error)),
                      },
                    )
                  }
                >
                  {t("proposal.send")}
                </Button>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">
                {statusLabel}
              </span>
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={`flex w-full items-center gap-2 border px-3 py-2 text-left text-xs ${
            closed ? "text-muted-foreground" : "border-state-warning"
          }`}
          onClick={() => setExpanded(true)}
        >
          {closed ? null : (
            <WarningIcon
              aria-hidden="true"
              className="size-4 shrink-0 text-state-warning"
            />
          )}
          <span>{collapsedHint}</span>
          <span className="ml-auto shrink-0">{t("proposal.expand")}</span>
        </button>
      )}
    </section>
  );
}
