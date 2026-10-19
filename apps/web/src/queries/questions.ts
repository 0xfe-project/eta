import type { JsonValue } from "@eta/client-contracts";
import type { SessionSections } from "@/queries/sessions";
import { useMemo } from "react";
import { useConversationList } from "@/queries/conversations";
import { sessionTarget, useSessionActions } from "@/queries/sessions";
import { useTargets } from "@/queries/wire";

/**
 * A question a run is standing still on. The conversation list says who is waiting (a member
 * whose reply is `waiting_for_input`); the question itself is in that member's session (`ask`).
 */
export interface Question {
  /** The session's id for it: what an answer names. */
  id: string;
  conversationId: string;
  agentId: string;
  sessionId: string;
  prompt: string;
  options: string[];
  /** More than one option may be chosen. */
  multi: boolean;
}

const NONE: Question[] = [];

/** Every question waiting for the user, or only those of one conversation. */
export function useQuestions(conversationId?: string): Question[] {
  const { conversations } = useConversationList();
  const waiting = useMemo(
    () =>
      conversations
        .filter(
          (conversation) =>
            conversationId === undefined || conversation.id === conversationId,
        )
        .flatMap((conversation) =>
          conversation.participants.flatMap((member) =>
            member.status === "waiting_for_input" && member.sessionId !== null
              ? [
                  {
                    conversationId: conversation.id,
                    agentId: member.agentId,
                    sessionId: member.sessionId,
                  },
                ]
              : [],
          ),
        ),
    [conversations, conversationId],
  );
  const states = useTargets(
    waiting.map((member) => sessionTarget(member.sessionId)),
  );
  return useMemo(() => {
    const questions = waiting.flatMap((member, index): Question[] => {
      const ask = states[index]?.sections.ask as
        | SessionSections["ask"]
        | undefined;
      const pending = ask?.pending;
      return pending === undefined
        ? []
        : [
            {
              id: pending.questionId,
              ...member,
              prompt: pending.question,
              options: pending.options ?? [],
              multi: pending.multi === true,
            },
          ];
    });
    return questions.length === 0 ? NONE : questions;
  }, [waiting, states]);
}

/** Answering, and giving up on a question (which also ends the run waiting on it). */
export function useAnswerQuestion() {
  const { answer, askAbort } = useSessionActions();
  return {
    answer,
    askAbort,
    /** Choose from the options, or write a free answer when it has none. */
    choose: (
      question: Question,
      selections: string[],
      options?: MutateOptions,
    ) =>
      answer.mutate(
        {
          session: question.sessionId,
          questionId: question.id,
          response:
            question.options.length === 0
              ? ({ kind: "freeform", text: selections.join("\n") } as JsonValue)
              : ({ kind: "selection", selections } as JsonValue),
        },
        options,
      ),
    abort: (question: Question, options?: MutateOptions) =>
      askAbort.mutate(
        { session: question.sessionId, questionId: question.id },
        options,
      ),
  };
}

interface MutateOptions {
  onError?: (error: Error) => void;
}
