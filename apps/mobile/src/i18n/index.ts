// Every string in two languages, one small dictionary per feature (`features/<x>/i18n.ts`). Keys are
// English paths; values may hold `{name}`. `t` reads the language signal, so a screen redraws when
// the language changes in 设置.

import { locale, signal, Storage } from "nsh";
import { i18n as chat } from "../features/chat/i18n";
import { i18n as connect } from "../features/connect/i18n";
import { i18n as conversations } from "../features/conversations/i18n";
import { i18n as create } from "../features/create/i18n";
import { i18n as group } from "../features/group/i18n";
import { i18n as inbox } from "../features/inbox/i18n";
import { i18n as settings } from "../features/settings/i18n";
import { i18n as tasks } from "../features/tasks/i18n";
import { common } from "./common";

const LANGUAGE_KEY = "eta.language";

export type Language = "zh" | "en";

const zh = {
  ...common.zh,
  ...connect.zh,
  ...inbox.zh,
  ...conversations.zh,
  ...chat.zh,
  ...group.zh,
  ...tasks.zh,
  ...create.zh,
  ...settings.zh,
};
const en: Record<keyof typeof zh, string> = {
  ...common.en,
  ...connect.en,
  ...inbox.en,
  ...conversations.en,
  ...chat.en,
  ...group.en,
  ...tasks.en,
  ...create.en,
  ...settings.en,
};

export type TextKey = keyof typeof zh;

const systemLanguage = (): Language =>
  locale().toLowerCase().startsWith("zh") ? "zh" : "en";

export const language = signal<Language>(systemLanguage());

export function setLanguage(next: Language): void {
  language.set(next);
  void Storage.setItem(LANGUAGE_KEY, next);
}

export async function loadLanguage(): Promise<void> {
  const stored = await Storage.getItem(LANGUAGE_KEY);
  if (stored === "zh" || stored === "en") language.set(stored);
}

export function t(
  key: TextKey,
  params?: Record<string, string | number>,
): string {
  const text = (language() === "zh" ? zh : en)[key];
  if (params === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}
