import type { EtaPlugin } from "../editor";
import { docText } from "@eta/client-contracts/composer-doc";
import {
  charCount,
  MAX_MESSAGE_CHARS,
} from "@eta/client-contracts/composer-draft";
import { signal } from "nsh";
import { characterCount } from "nsh/base";

/**
 * A message's length limit: over it, the place says so and does not send. Nothing is cut off —
 * the words are the user's to shorten. Folded pastes count with their text; typed text is counted
 * by the editor (`characterCount`), the whole only when that is near the limit.
 */
export function limit(
  max = MAX_MESSAGE_CHARS,
): EtaPlugin & { tooLong: () => boolean } {
  const tooLong = signal(false);
  return {
    name: "limit",
    plugins: [characterCount()],
    tooLong,
    setup(editor) {
      const check = () => {
        const text = docText(editor.doc());
        tooLong.set(text.length > max && charCount(text) > max);
      };
      check();
      return editor.session.on("revision", check);
    },
  };
}
