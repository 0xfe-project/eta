import type { InboxResponse, InteractionView } from "@/queries/inbox";
import { useMemo } from "react";
import { useAnswerInteraction, usePendingInteractions } from "@/queries/inbox";

/**
 * A question a run is standing still on, as a conversation shows it: a pending row of the inbox
 * that belongs to a member of a conversation. (The inbox page has the rest, a bare session's.)
 */
export interface Question {
  /** The inbox row's id: what an answer names. */
  id: string;
  conversationId: string;
  agentId: string;
  prompt: string;
  options: string[];
  /** More than one option may be chosen. */
  multi: boolean;
}

const NONE: Question[] = [];

/** Every question waiting for the user in a conversation, or only those of one. */
export function useQuestions(conversationId?: string): Question[] {
  const pending = usePendingInteractions();
  return useMemo(() => {
    const questions = pending.flatMap((row): Question[] =>
      row.agentId !== null &&
      row.conversationId !== null &&
      (conversationId === undefined || row.conversationId === conversationId)
        ? [
            {
              id: row.id,
              conversationId: row.conversationId,
              agentId: row.agentId,
              prompt: row.prompt,
              options: row.options,
              multi: row.multi,
            },
          ]
        : [],
    );
    return questions.length === 0 ? NONE : questions;
  }, [pending, conversationId]);
}

interface MutateOptions {
  onError?: (error: Error) => void;
}

/** Answering, and giving up on a question (declining it ends the run waiting on it). */
export function useAnswerQuestion() {
  const answer = useAnswerInteraction();
  const send = (
    question: Pick<InteractionView, "id">,
    response: InboxResponse,
    options?: MutateOptions,
  ) => answer.mutate({ id: question.id, response }, options);
  return {
    answer,
    /** Choose from the options, or write a free answer when it has none. */
    choose: (
      question: Pick<InteractionView, "id" | "options">,
      selections: string[],
      options?: MutateOptions,
    ) =>
      send(
        question,
        question.options.length === 0
          ? { kind: "freeform", text: selections.join("\n") }
          : { kind: "selection", selections },
        options,
      ),
    abort: (question: Pick<InteractionView, "id">, options?: MutateOptions) =>
      send(question, { kind: "none" }, options),
  };
}
