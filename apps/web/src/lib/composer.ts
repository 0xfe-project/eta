import type { Draft } from "@eta/client-contracts/composer-draft";
import { isLongPaste, plainDraft } from "@eta/client-contracts/composer-draft";
import { translate } from "@/lib/i18n";
import { randomUUID } from "@/lib/random-uuid";

export * from "@eta/client-contracts/composer-draft";

/** A paste too long to send as text goes as a file of this name. */
export const pasteFileName = () => translate("chat:attachments.pastedFileName");

/** A sent message's text back as a draft, to edit and send again: long text as a block again. */
export function draftOf(text: string): Draft {
  return isLongPaste(text)
    ? [{ type: "paste", id: randomUUID(), text }]
    : plainDraft(text);
}
