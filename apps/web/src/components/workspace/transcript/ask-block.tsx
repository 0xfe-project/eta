import type { AnsweringQuestion, Question } from "@/queries/questions";
import { useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * A question a run is standing still on.
 *
 * Same grammar as the composer's toolbar — a mono label, the question, its options as bordered
 * controls — because it is the same kind of thing: something you press to keep the work going.
 * A question with options is answered by pressing one (several, then Send, when more than one may
 * be chosen); one without is answered in words. Giving up ends the run that is waiting.
 */
export function AskBlock({
  question,
  who,
  pending,
  onChoose,
  onAbort,
}: {
  question: Question;
  /** Who is asking; in a group that is the first thing you need to know. */
  who?: string | undefined;
  /** The answer on its way to the host, once one has been submitted. */
  pending?: AnsweringQuestion | undefined;
  onChoose: (question: Question, selections: string[]) => void;
  onAbort: (question: Question) => void;
}) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState("");
  const busy = pending !== undefined;
  const sending = (option: string) =>
    pending?.selections?.includes(option) === true;
  return (
    <section
      className="ask-block"
      aria-label={translateText("confirmations.requestLabel")}
    >
      <div className="ask-head">
        <span>{translateText("confirmations.requestLabel")}</span>
        {who === undefined ? null : (
          <span className="text-foreground">{who}</span>
        )}
      </div>
      <p className="ask-body">{question.prompt}</p>
      {question.context === undefined ? null : (
        <p className="whitespace-pre-wrap text-xs text-muted-foreground">
          {question.context}
        </p>
      )}
      <div className="ask-options">
        {question.options.map((option) =>
          question.multi ? (
            <button
              key={option}
              type="button"
              className="ask-option"
              aria-pressed={picked.includes(option) || sending(option)}
              disabled={busy}
              onClick={() =>
                setPicked(
                  picked.includes(option)
                    ? picked.filter((p) => p !== option)
                    : [...picked, option],
                )
              }
            >
              {option}
            </button>
          ) : (
            <button
              key={option}
              type="button"
              className="ask-option"
              aria-pressed={sending(option)}
              disabled={busy}
              onClick={() => onChoose(question, [option])}
            >
              {option}
            </button>
          ),
        )}
        {question.options.length === 0 ? (
          <form
            className="flex w-full gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (text.trim()) onChoose(question, [text.trim()]);
            }}
          >
            <input
              value={text}
              onChange={(event) => setText(event.target.value)}
              disabled={busy}
              aria-label={translateText("confirmations.requestLabel")}
              className="min-w-0 flex-1 border border-border bg-transparent px-2 text-xs outline-none focus:border-border-strong"
            />
            <button type="submit" className="ask-option" disabled={busy}>
              {translateText("common:actions.send")}
            </button>
          </form>
        ) : null}
        {question.multi ? (
          <button
            type="button"
            className="ask-option"
            disabled={busy || picked.length === 0}
            onClick={() => onChoose(question, picked)}
          >
            {translateText("common:actions.send")}
          </button>
        ) : null}
        <button
          type="button"
          className="ask-option text-muted-foreground"
          disabled={busy}
          onClick={() => onAbort(question)}
        >
          {translateText("confirmations.giveUp")}
        </button>
      </div>
    </section>
  );
}
