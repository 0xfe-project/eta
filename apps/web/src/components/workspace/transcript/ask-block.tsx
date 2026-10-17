import type { Interaction } from "@/queries/chat";
import { useTranslation } from "react-i18next";

/**
 * A question a run is standing still on.
 *
 * Same grammar as the composer's toolbar — a mono label, the question, its options as bordered
 * controls — because it is the same kind of thing: something you press to keep the work going.
 */
export function AskBlock({
  interaction,
  who,
  onAnswer,
}: {
  interaction: Interaction;
  /** Who is asking; in a group that is the first thing you need to know. */
  who?: string | undefined;
  onAnswer: (interactionId: string, value: string) => void;
}) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
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
      <p className="ask-body">{interaction.prompt}</p>
      <div className="ask-options">
        {interaction.options.map((option: { value: string; label: string }) => (
          <button
            key={option.value}
            type="button"
            className="ask-option"
            onClick={() => onAnswer(interaction.id, option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </section>
  );
}
