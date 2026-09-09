import { useAppI18n } from "../i18n.ts";
import { useAppTheme, type ThemePreference } from "../app/theme.tsx";

export function SettingsPage() {
	const { t, locale, setLocale } = useAppI18n();
	const { theme, setTheme } = useAppTheme();

	const themes: { value: ThemePreference; label: string }[] = [
		{ value: "dark", label: t("theme.dark") },
		{ value: "light", label: t("theme.light") },
		{ value: "system", label: t("theme.system") },
	];

	return (
		<main className="mx-auto flex w-full max-w-[520px] flex-col gap-6 p-6" data-testid="settings-page">
			<h1 className="text-lg font-semibold">{t("settings.title")}</h1>
			<section>
				<h2 className="mb-2 text-sm text-muted">{t("settings.theme")}</h2>
				<div className="flex gap-2">
					{themes.map((option) => (
						<button
							key={option.value}
							data-testid={`theme-${option.value}`}
							data-active={theme === option.value ? "1" : "0"}
							onClick={() => setTheme(option.value)}
							className={`rounded-lg border px-3 py-1.5 text-sm ${theme === option.value ? "border-accent text-accent" : "border-border hover:bg-overlay"}`}
						>
							{option.label}
						</button>
					))}
				</div>
			</section>
			<section>
				<h2 className="mb-2 text-sm text-muted">{t("settings.language")}</h2>
				<div className="flex gap-2">
					<button data-testid="locale-zh-CN" data-active={locale === "zh-CN" ? "1" : "0"} onClick={() => setLocale("zh-CN")} className={`rounded-lg border px-3 py-1.5 text-sm ${locale === "zh-CN" ? "border-accent text-accent" : "border-border hover:bg-overlay"}`}>中文</button>
					<button data-testid="locale-en" data-active={locale === "en" ? "1" : "0"} onClick={() => setLocale("en")} className={`rounded-lg border px-3 py-1.5 text-sm ${locale === "en" ? "border-accent text-accent" : "border-border hover:bg-overlay"}`}>English</button>
				</div>
			</section>
		</main>
	);
}
