import type { LanguagePreference } from "@/lib/i18n";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  readLanguagePreference,
  setLanguagePreference,
  subscribeLanguagePreference,
} from "@/lib/i18n";
import { Select, SelectOption } from "./workspace/select-field";

export function LanguageSettings() {
  const { t } = useTranslation(["settings", "common"] as const);
  const preference = useSyncExternalStore(
    subscribeLanguagePreference,
    readLanguagePreference,
    (): LanguagePreference => "system",
  );
  return (
    <Select
      id="language"
      value={preference}
      aria-label={t("appearance.language")}
      onValueChange={(value) => {
        const next = value as LanguagePreference;
        setLanguagePreference(next);
      }}
    >
      <SelectOption value="system">{t("appearance.system")}</SelectOption>
      <SelectOption value="zh">Chinese</SelectOption>
      <SelectOption value="en">English</SelectOption>
    </Select>
  );
}
