import { afterEach, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import {
  i18n,
  languageStorageKey,
  readLanguagePreference,
  setLanguagePreference,
} from "@/lib/i18n";
import { LanguageProvider } from "./language-provider";
import { LanguageSettings } from "./language-settings";
import { Loading } from "./states";
import { AgentStatus } from "./workspace/agent-identity";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanup: (() => void)[] = [];

afterEach(async () => {
  await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
  rstest.restoreAllMocks();
  setLanguagePreference("system");
  localStorage.removeItem(languageStorageKey);
});

function Content() {
  const { t, i18n: instance } = useTranslation(["settings", "common"] as const);
  return (
    <section lang={instance.resolvedLanguage}>
      <h1>{t("title")}</h1>
      <LanguageSettings />
      <AgentStatus status="idle" />
      <Loading />
    </section>
  );
}

async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  await act(async () =>
    root.render(
      <LanguageProvider>
        <Content />
      </LanguageProvider>,
    ),
  );
  return container;
}

it("detects the system language and switches settings and shared components immediately", async () => {
  localStorage.removeItem(languageStorageKey);
  rstest.spyOn(navigator, "languages", "get").mockReturnValue(["zh-CN"]);
  const container = await mount();
  expect(container.querySelector("h1")?.textContent).toBe("设置");
  expect(container.textContent).toContain("正在加载…");
  const trigger = container.querySelector<HTMLElement>('[role="combobox"]')!;
  await act(async () =>
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  const english = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((option) => option.textContent === "English")!;
  await act(async () =>
    english.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(readLanguagePreference()).toBe("en");
  expect(container.querySelector("h1")?.textContent).toBe("Settings");
  expect(container.textContent).toContain("Idle");
  expect(container.textContent).toContain("Loading…");
  expect(trigger.getAttribute("aria-label")).toBe("Language");
  expect(JSON.parse(localStorage.getItem(languageStorageKey)!)).toBe("en");
});

it("restores the saved choice and synchronizes changes from another tab", async () => {
  localStorage.setItem(languageStorageKey, JSON.stringify("en"));
  rstest.spyOn(navigator, "languages", "get").mockReturnValue(["zh-CN"]);
  const container = await mount();
  expect(container.querySelector("h1")?.textContent).toBe("Settings");
  await act(async () => {
    localStorage.setItem(languageStorageKey, JSON.stringify("zh"));
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: languageStorageKey,
        newValue: JSON.stringify("zh"),
      }),
    );
  });
  expect(container.querySelector("h1")?.textContent).toBe("设置");
  expect(container.querySelector('[role="combobox"]')?.textContent).toContain(
    "中文",
  );
});

it("follows system changes while keeping an explicit preference", async () => {
  localStorage.removeItem(languageStorageKey);
  const languages = rstest
    .spyOn(navigator, "languages", "get")
    .mockReturnValue(["fr-FR"]);
  const container = await mount();
  expect(container.querySelector("h1")?.textContent).toBe("Settings");
  await act(async () => {
    languages.mockReturnValue(["zh-TW"]);
    window.dispatchEvent(new Event("languagechange"));
  });
  expect(container.querySelector("h1")?.textContent).toBe("设置");
  await act(async () => setLanguagePreference("en"));
  await act(async () => window.dispatchEvent(new Event("languagechange")));
  expect(i18n.resolvedLanguage).toBe("en");
  expect(container.querySelector("h1")?.textContent).toBe("Settings");
});
