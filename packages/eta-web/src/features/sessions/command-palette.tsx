import { useMemo } from "react";
import { useLocation } from "wouter";
import { Command } from "cmdk";
import { useAppI18n } from "../../i18n.ts";
import { etaStore, useEta } from "../../lib/eta-store.ts";
import { useAppTheme } from "../../app/theme.tsx";
import { useShell } from "../../app/app-shell.tsx";

interface CommandEntry {
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

	const commands = useMemo<CommandEntry[]>(
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

	return (
		<div data-testid="command-palette" className="border-2 border-border-strong bg-popover text-popover-foreground shadow-[6px_6px_0_0_var(--shadow)]">
			<Command data-testid="command-root" className="bg-transparent">
				<Command.Input
					data-testid="palette-input"
					autoFocus
					placeholder={t("palette.placeholder")}
					className="w-full border-b border-border bg-transparent px-3 py-2 text-sm outline-none"
				/>
				<Command.List className="max-h-[300px] overflow-y-auto p-1">
					<Command.Empty className="px-3 py-2 font-mono text-[11px] text-muted">{t("palette.empty")}</Command.Empty>
					{commands.map((command) => (
						<Command.Item
							key={command.id}
							data-testid={`palette-item-${command.id}`}
							onSelect={command.run}
							className="flex cursor-pointer items-center px-3 py-1.5 text-sm outline-none select-none data-[selected=true]:bg-primary data-[selected=true]:text-primary-foreground"
						>
							{command.label}
						</Command.Item>
					))}
				</Command.List>
			</Command>
		</div>
	);
}
