import { For, createSignal } from "solid-js";
import { useAppI18n } from "../i18n.ts";
import { useAppTheme, type ThemePreference } from "../app/theme.tsx";

export function SettingsPage() {
	const i18n = useAppI18n();
	const theme = useAppTheme();
	const [notifyState, setNotifyState] = createSignal(typeof Notification === "undefined" ? "unsupported" : Notification.permission);

	const themes = (): { value: ThemePreference; label: string }[] => [
		{ value: "dark", label: i18n.t("theme.dark") },
		{ value: "light", label: i18n.t("theme.light") },
		{ value: "system", label: i18n.t("theme.system") },
	];

	return (
		<main class="mx-auto flex w-full max-w-[520px] flex-col gap-6 p-6" data-testid="settings-page">
			<header class="flex items-center gap-2">
				<h1 class="text-lg font-semibold">{i18n.t("settings.title")}</h1>
				<button
					data-testid="settings-close"
					title={i18n.t("settings.close")}
					onClick={() => (window.history.length > 1 ? window.history.back() : window.location.assign("/"))}
					class="mono ml-auto border border-border-strong px-3 py-1 text-xs text-muted hover:text-foreground"
				>
					✕ {i18n.t("settings.close")}
				</button>
			</header>
			<section>
				<h2 class="mb-2 text-sm text-muted">{i18n.t("settings.theme")}</h2>
				<div class="flex gap-2">
					<For each={themes()}>
						{(option) => (
							<button
								data-testid={`theme-${option.value}`}
								data-active={theme.theme === option.value ? "1" : "0"}
								onClick={() => theme.setTheme(option.value)}
								class={`border px-3 py-1.5 text-sm ${theme.theme === option.value ? "border-accent text-accent" : "border-border hover:bg-overlay"}`}
							>
								{option.label}
							</button>
						)}
					</For>
				</div>
			</section>
			<section>
				<h2 class="mb-2 text-sm text-muted">{i18n.t("settings.notifications")}</h2>
				<button
					data-testid="notify-enable"
					disabled={notifyState() !== "default"}
					onClick={() => {
						if (typeof Notification !== "undefined") void Notification.requestPermission().then((permission) => setNotifyState(permission));
					}}
					class="border border-border px-3 py-1.5 text-sm hover:bg-overlay disabled:opacity-40"
				>
					{notifyState() === "granted" ? "✓" : notifyState() === "unsupported" ? "—" : "⌶"} {notifyState()}
				</button>
			</section>
			<section>
				<h2 class="mb-2 text-sm text-muted">{i18n.t("settings.language")}</h2>
				<div class="flex gap-2">
					<button data-testid="locale-zh-CN" data-active={i18n.locale === "zh-CN" ? "1" : "0"} onClick={() => i18n.setLocale("zh-CN")} class={`border px-3 py-1.5 text-sm ${i18n.locale === "zh-CN" ? "border-accent text-accent" : "border-border hover:bg-overlay"}`}>
						中文
					</button>
					<button data-testid="locale-en" data-active={i18n.locale === "en" ? "1" : "0"} onClick={() => i18n.setLocale("en")} class={`border px-3 py-1.5 text-sm ${i18n.locale === "en" ? "border-accent text-accent" : "border-border hover:bg-overlay"}`}>
						English
					</button>
				</div>
			</section>
		</main>
	);
}
