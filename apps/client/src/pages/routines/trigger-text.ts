import { localizedText } from "../../i18n";
import { triggerCatalogText } from "../../i18n/messages/trigger-catalog";

/**
 * The catalog texts of the built-in trigger providers, in the interface language. The backend sends
 * English; a missing entry (a Composio trigger, or one added without a translation) keeps its text.
 */

function translated(
  fallback: string,
  text: readonly [string, string] | undefined,
) {
  return text ? localizedText(fallback, text[1]) : fallback;
}

export function providerText(provider: string, fallback: string) {
  return translated(fallback, triggerCatalogText[provider]?.label);
}

export function sourceText(provider: string, source: string, fallback: string) {
  return translated(fallback, triggerCatalogText[provider]?.sources[source]);
}

export function triggerNameText(
  provider: string,
  trigger: string,
  fallback: string,
) {
  return translated(
    fallback,
    triggerCatalogText[provider]?.triggers[trigger]?.name,
  );
}

export function triggerDescriptionText(
  provider: string,
  trigger: string,
  fallback: string,
) {
  return translated(
    fallback,
    triggerCatalogText[provider]?.triggers[trigger]?.description,
  );
}

function fieldText(provider: string, trigger: string, key: string) {
  return triggerCatalogText[provider]?.triggers[trigger]?.fields[key];
}

export function fieldTitleText(
  provider: string,
  trigger: string,
  key: string,
  fallback: string,
) {
  return translated(fallback, fieldText(provider, trigger, key)?.title);
}

export function fieldDescriptionText(
  provider: string,
  trigger: string,
  key: string,
  fallback: string,
) {
  return translated(fallback, fieldText(provider, trigger, key)?.description);
}

export function fieldOptionText(
  provider: string,
  trigger: string,
  key: string,
  value: unknown,
  fallback: string,
) {
  return translated(
    fallback,
    fieldText(provider, trigger, key)?.options?.[String(value)],
  );
}
