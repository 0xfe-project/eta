import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useAppI18n } from "../../i18n.ts";
import { etaStore, useEta } from "../../lib/eta-store.ts";
import { useAppTheme } from "../../app/theme.tsx";
import { useShell } from "../../app/app-shell.tsx";

interface Command {
	id: string;
	label: string;
	run(): void;
}

export function CommandPalette() {
	const { t, locale, setLocale } = useAppI18n();
	const { setTheme } = useAppTheme();
	const state = useEta();
	const [, navigate] = useLocation();
	const shell = useShell();
	const [filter, setFilter] = useState("");

	const commands = useMemo<Command[]>(
		() => [
			...state.sessions.map((session) => ({
				id: `focus-${session.name}`,
				label: `${t("nav.sessions")} → ${session.name}`,
				run: () => {
					etaStore().send({ op: "focus", session: session.name });
					shell.setPaletteOpen(false);
					navigate("/");
				},
			})),
			{
				id: "new",
				label: t("nav.new"),
				run: () => {
					shell.setPaletteOpen(false);
					navigate("/new");
				},
			},
			{
				id: "theme-dark",
				label: `${t("settings.theme")}: ${t("theme.dark")}`,
				run: () => {
					setTheme("dark");
					shell.setPaletteOpen(false);
				},
			},
			{
				id: "theme-light",
				label: `${t("settings.theme")}: ${t("theme.light")}`,
				run: () => {
					setTheme("light");
					shell.setPaletteOpen(false);
				},
			},
			{
				id: "locale-toggle",
				label: `${t("settings.language")}: ${locale === "en" ? "中文" : "English"}`,
				run: () => {
					setLocale(locale === "en" ? "zh-CN" : "en");
					shell.setPaletteOpen(false);
				},
			},
		],
		[state.sessions, locale, navigate, setLocale, setTheme, shell, t],
	);

	const needle = filter.trim().toLowerCase();
	const shown = needle.length === 0 ? commands : commands.filter((command) => command.label.toLowerCase().includes(needle));

	return (
		<div data-testid="command-palette" className="rounded-xl border border-border bg-elevated p-2 shadow-[var(--shadow)]">
			<input
				data-testid="palette-input"
				autoFocus
				value={filter}
				onChange={(event) => setFilter(event.target.value)}
				className="w-full rounded-lg bg-transparent px-2 py-1 text-sm outline-none"
			/>
			<div className="max-h-[300px] overflow-y-auto">
				{shown.map((command) => (
					<button
						key={command.id}
						data-testid={`palette-item-${command.id}`}
						onClick={command.run}
						className="block w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-overlay"
					>
						{command.label}
					</button>
				))}
			</div>
		</div>
	);
}
