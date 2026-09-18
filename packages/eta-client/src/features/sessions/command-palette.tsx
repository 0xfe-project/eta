import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
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
	const i18n = useAppI18n();
	const theme = useAppTheme();
	const state = useEta();
	const navigate = useNavigate();
	const shell = useShell();
	const [query, setQuery] = createSignal("");
	const [active, setActive] = createSignal(0);

	const commands = createMemo<CommandEntry[]>(() => [
		...state.sessions.map((session) => ({
			id: `focus-${session.name}`,
			label: `${i18n.t("nav.sessions")} → ${session.name}`,
			run: () => {
				etaStore().send({ op: "focus", session: session.name });
				shell.setPaletteOpen(false);
				void navigate("/");
			},
		})),
		{
			id: "new",
			label: i18n.t("nav.new"),
			run: () => {
				shell.setPaletteOpen(false);
				void navigate("/new");
			},
		},
		{
			id: "theme-dark",
			label: `${i18n.t("settings.theme")}: ${i18n.t("theme.dark")}`,
			run: () => {
				theme.setTheme("dark");
				shell.setPaletteOpen(false);
			},
		},
		{
			id: "theme-light",
			label: `${i18n.t("settings.theme")}: ${i18n.t("theme.light")}`,
			run: () => {
				theme.setTheme("light");
				shell.setPaletteOpen(false);
			},
		},
		{
			id: "locale-toggle",
			label: `${i18n.t("settings.language")}: ${i18n.locale === "en" ? "中文" : "English"}`,
			run: () => {
				i18n.setLocale(i18n.locale === "en" ? "zh-CN" : "en");
				shell.setPaletteOpen(false);
			},
		},
	]);

	const filtered = createMemo(() => {
		const needle = query().trim().toLowerCase();
		return needle.length === 0 ? commands() : commands().filter((command) => command.label.toLowerCase().includes(needle));
	});

	createEffect(() => {
		filtered();
		setActive(0);
	});

	const onKey = (event: KeyboardEvent) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const size = filtered().length;
			if (size === 0) return;
			const step = event.key === "ArrowDown" ? 1 : -1;
			setActive((index) => (index + step + size) % size);
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			filtered()[active()]?.run();
		}
	};

	return (
		<div data-testid="command-palette" class="border border-overlay-hover bg-popover text-popover-foreground shadow-[6px_6px_0_0_var(--shadow)]">
			<div data-testid="command-root" class="bg-transparent">
				<input
					data-testid="palette-input"
					autofocus
					placeholder={i18n.t("palette.placeholder")}
					value={query()}
					onInput={(event) => setQuery(event.currentTarget.value)}
					onKeyDown={onKey}
					class="w-full border-b border-border bg-transparent px-3 py-2 text-sm outline-none"
				/>
				<div class="max-h-[300px] overflow-y-auto p-1">
					<Show when={filtered().length === 0}>
						<p class="px-3 py-2 font-mono text-[11px] text-muted">{i18n.t("palette.empty")}</p>
					</Show>
					<For each={filtered()}>
						{(command, index) => (
							<button
								data-testid={`palette-item-${command.id}`}
								data-selected={index() === active() ? "true" : "false"}
								onClick={() => command.run()}
								class={`flex w-full cursor-pointer items-center px-3 py-1.5 text-left text-sm outline-none select-none ${index() === active() ? "bg-primary text-primary-foreground" : ""}`}
							>
								{command.label}
							</button>
						)}
					</For>
				</div>
			</div>
		</div>
	);
}
