import { translate } from "@/lib/i18n";
import { wireErrorMessage } from "@/queries/wire";

// Keep the original error on the query/call; only the skill UI text is translated.
export function skillErrorMessage(error: unknown): string {
  const message = wireErrorMessage(error);
  if (/skill_files:target_moved\b/.test(message))
    return translate("skills:targetMoved");
  if (/skill_files:(?:byte_limit|text_limit)\b/.test(message))
    return translate("skills:byteLimit");
  return message;
}
