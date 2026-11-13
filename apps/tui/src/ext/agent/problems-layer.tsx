import { Text, useInput } from "ink";
import { useEffect } from "react";
import { useInputActive } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { LayerFrame } from "../../ui/components/layer-frame";
import { agentMessages } from "./messages";

export type ProblemsAnswer = "edit-again" | "discard";

/**
 * Every problem with the edited agent, one per line. Enter answers `edit-again`, Esc `discard`;
 * a layer that goes without an answer (the shell closed it) answers `discard`, so `onAnswer`
 * may be called more than once and must act on the first call only.
 */
export function ProblemsLayer({
  title,
  problems,
  onAnswer,
}: {
  title: string;
  problems: readonly string[];
  onAnswer: (answer: ProblemsAnswer) => void;
}) {
  const t = useMessages(agentMessages);
  const active = useInputActive();
  useInput(
    (_input, key) => {
      if (key.return) onAnswer("edit-again");
      else if (key.escape) onAnswer("discard");
    },
    { isActive: active },
  );
  useEffect(() => () => onAnswer("discard"), [onAnswer]);
  return (
    <LayerFrame title={title} footer={t("problemsFooter")}>
      {problems.map((problem, index) => (
        // The same text can appear twice (a key written three times); the index tells them apart.
        // eslint-disable-next-line react/no-array-index-key
        <Text key={index}>{problem}</Text>
      ))}
    </LayerFrame>
  );
}
