import type { en } from "@/locales/resources";
import "i18next";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: typeof en;
    returnNull: false;
    strictKeyChecks: true;
    enableSelector: false;
  }
}
