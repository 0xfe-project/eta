import { setI18n } from "react-i18next";
import { beforeEach } from "vitest";
import { i18n } from "@/lib/i18n";

// Existing UI regressions exercise Chinese. Language-specific tests switch
// explicitly, using the same real resources and hooks as the application.
beforeEach(() => {
  setI18n(i18n);
  void i18n.changeLanguage("zh");
});
