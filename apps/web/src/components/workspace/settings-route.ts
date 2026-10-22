import type { SettingsSection } from "./workspace-store";
import {
  createStandardSchemaV1,
  parseAsStringEnum,
  useQueryStates,
} from "nuqs";
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

export const validateSettingsSearch = createStandardSchemaV1(navParsers, {
  partialOutput: true,
});

export function useSettingsSection() {
  return useQueryStates(navParsers, { history: "replace" });
}
