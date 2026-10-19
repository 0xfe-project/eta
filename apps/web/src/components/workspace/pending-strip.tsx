import type { AgentView } from "@eta/client-contracts";
import type { Question } from "@/queries/questions";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { agentName } from "@/queries/agents";

/**
 * What is waiting on you, above the conversation.
 *
 * A question raised inside a run sits in the timeline where it was asked — which is right when you
 * are reading that part. The strip is for the other case: you scrolled away, or the question came
 * from a member whose message is off screen. So it says who is asking and what about, in one line,
 * and lets you answer from there (a question that takes several options, or words, is answered in
 * its card).
 *
 * It is not a notification centre: no count of things you could deal with later, no items that are
 * not blocking a run. Everything here is a run standing still until you press something.
 */
export function PendingStrip({
  questions,
  agents,
  onChoose,
}: {
  questions: readonly Question[];
  /** Names by agent id: "who is asking" is the first thing the line has to say. */
  agents: readonly Pick<AgentView, "id" | "name">[];
  onChoose: (question: Question, selections: string[]) => void;
}) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  if (questions.length === 0) return null;
  return (
    <div
      role="status"
      aria-label={translateText("chat:pending.title")}
      className="mx-[1ch] mb-1 border border-state-warning px-2 py-1 text-xs"
    >
      {questions.slice(0, 3).map((question) => (
        <div
          key={question.id}
          className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 py-0.5")}
        >
          <span className="shrink-0 font-mono text-[10px] tracking-[0.08em] text-state-warning uppercase">
            {agentName(agents, question.agentId)}
          </span>
          <span
            className="min-w-0 flex-1 truncate font-mono text-[11px]"
            title={question.prompt}
          >
            {question.prompt}
          </span>
          {question.multi
            ? null
            : question.options.map((option) => (
                <Button
                  key={option}
                  size="xs"
                  variant="outline"
                  onClick={() => onChoose(question, [option])}
                >
                  {option}
                </Button>
              ))}
        </div>
      ))}
      {questions.length > 3 ? (
        <p className="pt-0.5 font-mono text-[10px] text-muted-foreground">
          {translateText("chat:pending.more", { count: questions.length - 3 })}
        </p>
      ) : null}
    </div>
  );
}
