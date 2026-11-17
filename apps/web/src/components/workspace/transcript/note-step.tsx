import { useTranslation } from "react-i18next";
import { Markdown } from "@/components/markdown";

/**
 * Something the agent said on the way, drawn as a step of the process: the same fold line as a
 * thought, its words under it in the thought's small type. Open, unlike a thought: these are the
 * words the agent meant to be read while it works. The answer itself is not drawn with this.
 */
export function NoteStep({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const { t: translateText } = useTranslation("chat");
  return (
    <details open className="thinking-block note-step">
      <summary className="thinking-block-header">
        <span aria-hidden="true" className="thinking-block-chevron">
          ▶
        </span>
        {translateText("process.note")}
      </summary>
      <div className="thinking-block-content note-step-content">
        <Markdown streaming={streaming} className="space-y-1">
          {text}
        </Markdown>
      </div>
    </details>
  );
}
