import { useTranslation } from "react-i18next";
import { Markdown } from "@/components/markdown";
import { Loading } from "@/components/states";
import { logBlocks } from "@/lib/run";
import { summarizeArgs } from "@/lib/tool-summary";
import { useSession } from "@/queries/sessions";
import { EmailProposalCard } from "./email-proposal-card";
import { ThinkingBlock } from "./transcript/thinking-block";
import { ToolCard } from "./transcript/tool-card";

export function EmailSessionLog({
  sessionId,
  startedAt,
}: {
  sessionId: string;
  startedAt: number;
}) {
  const { t } = useTranslation(["email"] as const);
  const session = useSession(sessionId);
  const rows = session?.transcript?.messages;
  if (rows === undefined) return <Loading layout="lines" />;
  const blocks = logBlocks(
    rows.filter((row) => row.at >= startedAt - 1),
    session?.core?.streaming,
  );
  const running = session?.core?.running === true;
  const result = [...blocks].reverse().find((block) => block.type === "text");
  return (
    <div className="space-y-3">
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <span
          aria-hidden="true"
          className={`size-1.5 ${
            running ? "animate-pulse bg-state-success" : "bg-foreground"
          }`}
        />
        {running ? t("thread.processing") : t("thread.processEnded")}
      </p>
      {result?.type === "text" ? (
        <section className="border-l-2 border-foreground pl-3">
          <h3 className="mb-1 text-xs font-medium">
            {running ? t("thread.currentOutput") : t("thread.result")}
          </h3>
          <Markdown className="text-xs">{result.text}</Markdown>
        </section>
      ) : null}
      {blocks.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("thread.noProcessLog")}
        </p>
      ) : (
        <details className="border">
          <summary className="cursor-pointer px-2 py-1.5 text-xs">
            {t("thread.processLog")}
          </summary>
          <ol className="space-y-2 border-t p-3 text-xs">
            {blocks.map((block) => {
              if (block.type === "thinking")
                return (
                  <li key={block.id}>
                    <ThinkingBlock text={block.text} />
                  </li>
                );
              if (block.type === "text")
                return (
                  <li key={block.id}>
                    <Markdown className="text-xs">{block.text}</Markdown>
                  </li>
                );
              if (block.type === "user") return null;
              const proposalId = (
                block.details as { emailProposalId?: unknown } | undefined
              )?.emailProposalId;
              if (
                typeof proposalId === "string" &&
                (block.name === "send_email" || block.name === "reply")
              ) {
                return (
                  <li key={block.id}>
                    <EmailProposalCard proposalId={proposalId} />
                  </li>
                );
              }
              return (
                <li key={block.id}>
                  <ToolCard
                    tool={block.name}
                    summary={summarizeArgs(block.input) || undefined}
                    status={block.status}
                    statusLabel={block.status}
                  >
                    {block.output ? <span>{block.output}</span> : null}
                  </ToolCard>
                </li>
              );
            })}
          </ol>
        </details>
      )}
    </div>
  );
}
