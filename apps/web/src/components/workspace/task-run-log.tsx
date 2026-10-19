import type { TaskRun } from "@/queries/tasks";
import { useTranslation } from "react-i18next";
import { Markdown } from "@/components/markdown";
import { Loading } from "@/components/states";
import { summarizeArgs } from "@/lib/tool-summary";
import { useLogBlocks } from "@/queries/sessions";
import { isActive } from "./task-format";
import { ThinkingBlock } from "./transcript/thinking-block";
import { ToolCard, ToolCardBlock } from "./transcript/tool-card";

/**
 * A run's log: its session's transcript, live while the run works. There is no second record of
 * what the executor did; this is the session drawn the way a conversation draws a reply.
 */
export function RunLog({ run }: { run: TaskRun }) {
  const { t: translateText } = useTranslation(["tasks", "chat"] as const);
  const blocks = useLogBlocks(run.sessionId);
  if (run.sessionId === null)
    return (
      <p className="text-xs text-muted-foreground">
        {translateText("log.empty")}
      </p>
    );
  if (blocks === undefined)
    return isActive(run.status) || run.status === "completed" ? (
      <Loading layout="lines" label={translateText("log.loading")} />
    ) : (
      <p className="text-xs text-muted-foreground">
        {translateText("log.empty")}
      </p>
    );
  if (blocks.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        {translateText("log.empty")}
      </p>
    );
  const statusLabels = {
    running: translateText("runStatus.running"),
    completed: translateText("log.done"),
    failed: translateText("log.failed"),
  };
  return (
    <ol
      aria-label={translateText("log.title")}
      className="space-y-2 border-l pl-3 text-xs"
    >
      {blocks.map((block) => (
        <li key={block.id} className="min-w-0">
          {block.type === "thinking" ? (
            <ThinkingBlock text={block.text} />
          ) : block.type === "text" ? (
            <Markdown className="text-xs">{block.text}</Markdown>
          ) : block.type === "user" ? (
            <p className="whitespace-pre-wrap text-muted-foreground wrap-anywhere">
              {block.text}
            </p>
          ) : (
            <ToolCard
              tool={block.name}
              summary={summarizeArgs(block.input) || undefined}
              status={block.status}
              statusLabel={statusLabels[block.status]}
            >
              {block.input === undefined || block.input === null ? null : (
                <ToolCardBlock label={translateText("chat:tools.arguments")}>
                  {typeof block.input === "string"
                    ? block.input
                    : JSON.stringify(block.input, null, 2)}
                </ToolCardBlock>
              )}
              {block.output === undefined ? null : (
                <ToolCardBlock label={translateText("chat:tools.result")}>
                  {block.output}
                </ToolCardBlock>
              )}
            </ToolCard>
          )}
        </li>
      ))}
    </ol>
  );
}
