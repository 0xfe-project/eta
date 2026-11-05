import type { SettingsSection } from "./workspace-store";
import { parseAsStringEnum, useQueryStates } from "nuqs";
import { settingsSections } from "./settings-sections";

// Where the settings page is inside itself: `/settings?section=<value>`. In the address rather
// than in the store, so a reload, a shared link and the back button all land on the same page.
// Replacing instead of pushing: the section is where you are inside one place, and back should
// leave settings rather than walk its rail.
const navParsers = {
  section: parseAsStringEnum<SettingsSection>(
    settingsSections.map(({ value }) => value),
  ),
};

/** A section that does not exist is the default one: an old link must not be an error page. */
export function validateSettingsSearch(search: Record<string, unknown>): {
  section?: SettingsSection;
} {
  const section = settingsSections.find(
    ({ value }) => value === search.section,
  );
  return section === undefined ? {} : { section: section.value };
}

export function useSettingsSection() {
  return useQueryStates(navParsers, { history: "replace" });
}
