import { useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Copy what was said, as it was written, from under the message: a reply's Markdown, or the
 * user's own text with its mentions and attachment references as typed (images are not text), or
 * a Captain review's text as the platform wrote it.
 *
 * The whole point of the footer is that it is out of the way until you want it: the button is
 * 10px mono in the same dim line as the time, and it says "copied" for a beat rather than
 * throwing a toast for a click you already know you made.
 */
export function CopyMessage({ text }: { text: string }) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const [copied, setCopied] = useState(false);
  if (text.trim().length === 0) return null;
  return (
    <button
      type="button"
      className="message-copy-btn font-mono text-[10px] uppercase tracking-[0.1em]"
      data-copied={copied}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(setCopied, 1200, false);
        } catch {
          /* no clipboard outside a secure context */
        }
      }}
    >
      {copied
        ? translateText("common:feedback.copied")
        : translateText("common:actions.copy")}
    </button>
  );
}
