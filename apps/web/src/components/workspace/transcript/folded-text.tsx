import { useTranslation } from "react-i18next";

import { isLongPaste } from "@/lib/composer";
import { useFold } from "@/lib/fold";

/**
 * The words of a message row, folded to a dozen lines when they are long.
 *
 * What you sent and what the agent wrote are folded by the same piece, on the same judgement
 * (`isLongPaste`) and with the same one-line control under them, because to the person skimming the
 * transcript they are one problem: a message longer than the exchange around it. Two sets of clamp
 * classes, one per author, is how the two start drifting apart.
 *
 * The choice is the reader's, kept by the row's id (see `lib/fold.ts`): a reply they opened stays
 * open through a reload, and a row drawn twice — a boxed reply's answer, in place and again inside
 * the dialog that opens the whole process — is one fold rather than two. The default is folded: a
 * settled reply is news by then, not a stream still arriving. (A reply still being written is not
 * drawn here at all; that is `LiveReply`.)
 *
 * A clamp, not a slice of the source: a code block or a table cut across one line is the layout's
 * doing, and the button that shows the rest is what puts that line back. What stays outside the fold
 * is the row's own edges — its cards, its footer, the text the copy button copies.
 */
export function FoldedText({
  id,
  text,
  className,
  children,
}: {
  /** The row these words belong to: whose choice the fold remembers. */
  id: string;
  /** The text as written. Its length is what decides whether there is a fold at all. */
  text: string;
  /** How the text is laid out, folded or not: the caller's own classes. */
  className?: string;
  children: React.ReactNode;
}) {
  const { t: translateText } = useTranslation("chat");
  const [open, fold] = useFold(id, false);
  if (!isLongPaste(text)) return <div className={className}>{children}</div>;
  return (
    <div className={className}>
      <div className={open ? undefined : "line-clamp-12"}>{children}</div>
      <button
        type="button"
        className="font-mono text-[10px] text-muted-foreground underline-offset-2 hover:underline"
        onClick={() => fold(!open)}
      >
        {open
          ? translateText("messages.collapse")
          : translateText("messages.expand")}
      </button>
    </div>
  );
}
