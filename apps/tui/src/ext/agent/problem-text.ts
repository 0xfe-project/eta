import type { Locale } from "../../config/types";
import type { ExpectedType, FileProblem } from "./agent-file";
import { AGENT_RUNTIMES } from "@eta/client-contracts";
import { translatorFor } from "../../i18n/messages";
import { THINKING_LEVELS } from "./agent-file";
import { agentMessages } from "./messages";

const WRONG_TYPE_TEXT = {
  text: "wrongTypeText",
  "text-or-null": "wrongTypeTextOrNull",
  "list-of-text": "wrongTypeList",
} as const satisfies Record<ExpectedType, keyof typeof agentMessages.en>;

/** One problem of the saved file as a line for the user, naming the key it is about. */
export function fileProblemText(problem: FileProblem, locale: Locale): string {
  const t = translatorFor(agentMessages, locale);
  switch (problem.kind) {
    case "syntax":
      return t("syntax", problem);
    case "duplicate-key":
      return t("duplicateKey", problem);
    case "not-a-mapping":
      return t("notMapping");
    case "unknown-key":
      return t("unknownKey", problem);
    case "missing-name":
      return t("missingName");
    case "blank-name":
      return t("blankName");
    case "wrong-type":
      return t(WRONG_TYPE_TEXT[problem.expected], problem);
    case "unknown-runtime":
      return t("unknownRuntime", {
        value: problem.value,
        choices: AGENT_RUNTIMES.join(", "),
      });
    case "unknown-thinking-level":
      return t("unknownThinkingLevel", {
        value: problem.value,
        choices: THINKING_LEVELS.join(", "),
      });
    case "model-format":
      return t("modelFormat", problem);
    case "model-runtime":
      return t("modelRuntime", problem);
  }
}
