import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

export const resources = {
	en: { translation: en },
	"zh-CN": { translation: zhCN },
} as const;

export type AppLocale = keyof typeof resources;
export type TranslationKey = keyof typeof en;

export const defaultLocale: AppLocale = "zh-CN";
export const supportedLocales: readonly AppLocale[] = ["en", "zh-CN"];
