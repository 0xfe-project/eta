import type { Locale } from "../config/types";

const LOCALE_VARIABLES = ["LC_ALL", "LC_MESSAGES", "LANG"] as const;

/**
 * The interface language: the setting when there is one, otherwise the first non-empty of
 * `LC_ALL`, `LC_MESSAGES` and `LANG`. A value starting with `zh` in any case is Chinese; anything
 * else, `C` and `POSIX` included, is English.
 */
export function chooseLocale(
  setting: Locale | undefined,
  env: NodeJS.ProcessEnv,
): Locale {
  if (setting !== undefined) return setting;
  const value = LOCALE_VARIABLES.map((name) => env[name]).find(
    (v) => v !== undefined && v !== "",
  );
  return value?.toLowerCase().startsWith("zh") ? "zh" : "en";
}
