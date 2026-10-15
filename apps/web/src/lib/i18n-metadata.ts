import type { TranslationKey } from "./i18n";
import { i18n, translate } from "./i18n";

const bundleDescriptions = {
  agenvo: "bundles:descriptions.agenvo",
  approval: "bundles:descriptions.approval",
  artifacts: "bundles:descriptions.artifacts",
  github: "bundles:descriptions.github",
  grok: "bundles:descriptions.grok",
  groups: "bundles:descriptions.groups",
  memory: "bundles:descriptions.memory",
  oomol: "bundles:descriptions.oomol",
  routines: "bundles:descriptions.routines",
  tasks: "bundles:descriptions.tasks",
} as const satisfies Record<string, TranslationKey>;

const pluginDescriptions = {
  agenvo: "bundles:pluginDescriptions.agenvo",
  approval: "bundles:pluginDescriptions.approval",
  artifacts: "bundles:pluginDescriptions.artifacts",
  github: "bundles:pluginDescriptions.github",
  grok: "bundles:pluginDescriptions.grok",
  groups: "bundles:pluginDescriptions.groups",
  memory: "bundles:pluginDescriptions.memory",
  oomol: "bundles:pluginDescriptions.oomol",
  routines: "bundles:pluginDescriptions.routines",
  tasks: "bundles:pluginDescriptions.tasks",
} as const satisfies Record<string, TranslationKey>;

const configFields = {
  "oomol:OO_API_KEY:title": "common:labels.apiKey",
  "oomol:OO_API_KEY:description": "bundles:configuration.oomol.apiKeyHelp",
  "oomol:OO_TEAM_NAME:title": "bundles:configuration.oomol.teamNameLabel",
  "oomol:OO_TEAM_NAME:description": "bundles:configuration.oomol.teamNameHelp",
} as const satisfies Record<string, TranslationKey>;

function lookup(
  registry: Readonly<Record<string, TranslationKey>>,
  id: string,
) {
  return Object.hasOwn(registry, id) ? registry[id] : undefined;
}

// Only known default metadata is translated. Edited descriptions and custom
// schemas remain user content, even when their IDs match a built-in bundle.
function translateDefault(key: TranslationKey | undefined, value: string) {
  if (!key) return value;
  const [namespace, path] = key.split(":");
  const isDefault = ["en", "zh"].some(
    (language) => i18n.getResource(language, namespace, path) === value,
  );
  return isDefault ? translate(key) : value;
}

export function translateBundleDescription(name: string, description: string) {
  return translateDefault(lookup(bundleDescriptions, name), description);
}

export function translatePluginDescription(name: string, description: string) {
  return translateDefault(lookup(pluginDescriptions, name), description);
}

export function translateBundleConfigField(
  bundleName: string,
  fieldName: string,
  kind: "title" | "description",
  value: string,
) {
  return translateDefault(
    lookup(configFields, `${bundleName}:${fieldName}:${kind}`),
    value,
  );
}
