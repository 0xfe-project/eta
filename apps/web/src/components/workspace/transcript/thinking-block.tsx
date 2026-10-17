import { useTranslation } from "react-i18next";

/**
 * What the agent worked through before answering.
 *
 * Folded, because it is context for reading the answer critically rather than a second answer
 * competing with it. The header carries the size: whether it is worth opening is a question you
 * answer from the length.
 */
export function ThinkingBlock({
  text,
  chars,
}: {
  text: string;
  /** Length reported by the host, so the header need not count the whole string again. */
  chars?: number;
}) {
  const { t: translateText } = useTranslation("chat");
  const length = chars ?? text.length;
  return (
    <details className="thinking-block">
      <summary className="thinking-block-header">
        <span aria-hidden="true" className="thinking-block-chevron">
          ▶
        </span>
        {translateText("thinking.fold", { count: length })}
      </summary>
      <pre className="thinking-block-content">{text}</pre>
    </details>
  );
}
