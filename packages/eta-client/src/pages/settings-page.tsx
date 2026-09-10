import { For, Show, createSignal, onMount, type JSX } from "solid-js";
import { useAppI18n } from "../i18n.ts";
import { useAppTheme, type ThemePreference } from "../app/theme.tsx";
import { sidebarPrefs, type ProjectSort } from "../lib/prefs.ts";
import { apiFetch } from "../lib/host.ts";

/** Mirrors eta-server/src/host.ts SettingsFile. */
interface SettingsFile {
	personaId?: string;
	modelId?: string;
	thinkingLevel?: string;
	keepRecentTokens?: number;
}

// Same list the composer chip cycles through.
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * A select keeps whatever value was assigned when it was set, so a stored id
 * whose option list landed later would leave the box blank. Checking against the
 * list makes the binding depend on the options, so the selection lands late too.
 */
function pick(list: { id: string }[], stored: string | undefined): string {
	return stored !== undefined && list.some((entry) => entry.id === stored) ? stored : "";
}

export function SettingsPage() {
	const i18n = useAppI18n();
	const theme = useAppTheme();
	const [notifyState, setNotifyState] = createSignal(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
	const [settings, setSettings] = createSignal<SettingsFile>({});
	const [personas, setPersonas] = createSignal<{ id: string; name: string }[]>([]);
	const [models, setModels] = createSignal<{ id: string; label: string }[]>([]);
	const [saveState, setSaveState] = createSignal<SaveState>("idle");

	const themes = (): { value: ThemePreference; label: string }[] => [
		{ value: "dark", label: i18n.t("theme.dark") },
		{ value: "light", label: i18n.t("theme.light") },
		{ value: "system", label: i18n.t("theme.system") },
	];

	const sorts = (): { value: ProjectSort; label: string }[] => [
		{ value: "recent", label: i18n.t("sidebar.sortRecent") },
		{ value: "name", label: i18n.t("sidebar.sortName") },
	];

	const get = async (url: string): Promise<unknown> => {
		try {
			return await (await apiFetch(url)).json();
		} catch {
			return null;
		}
	};

	onMount(() => {
		void get("/api/settings").then((body) => {
			if (body !== null && typeof body === "object") setSettings(body as SettingsFile);
		});
		void get("/api/personas").then((body) => {
			if (Array.isArray(body)) setPersonas(body as { id: string; name: string }[]);
		});
		void get("/api/models").then((body) => {
			const list = (body as { models?: { id: string; label: string }[] } | null)?.models;
			if (Array.isArray(list)) setModels(list);
		});
	});

	const save = (patch: Record<string, unknown>) => {
		setSaveState("saving");
		void apiFetch("/api/settings", { method: "POST", body: JSON.stringify(patch) })
			.then((response) => (response.ok ? (response.json() as Promise<SettingsFile>) : Promise.reject(new Error("save failed"))))
			.then((next) => {
				setSettings(next);
				setSaveState("saved");
			})
			.catch(() => setSaveState("error"));
	};

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
			<section data-testid="settings-section-sidebar">
				<h2 class="mb-2 text-sm text-muted">{i18n.t("settings.sidebar")}</h2>
				<div class="flex gap-2">
					<For each={sorts()}>
						{(option) => (
							<button
								data-testid={`sidebar-sort-${option.value}`}
								data-active={sidebarPrefs.sort === option.value ? "1" : "0"}
								onClick={() => sidebarPrefs.setSort(option.value)}
								class={`border px-3 py-1.5 text-sm ${sidebarPrefs.sort === option.value ? "border-accent text-accent" : "border-border hover:bg-overlay"}`}
							>
								{option.label}
							</button>
						)}
					</For>
				</div>
				<Show when={sidebarPrefs.collapsed.length > 0}>
					<button
						data-testid="sidebar-expand-all"
						onClick={() => sidebarPrefs.setCollapsed([])}
						class="mt-2 border border-border px-3 py-1.5 text-sm text-muted hover:bg-overlay"
					>
						{i18n.t("settings.expandGroups", { n: sidebarPrefs.collapsed.length })}
					</button>
				</Show>
			</section>
			<section data-testid="settings-section-defaults">
				<h2 class="flex items-center gap-2 text-sm text-muted">
					{i18n.t("settings.sessionDefaults")}
					<span data-testid="settings-save-state" class="mono text-[10px]">
						{saveState() === "idle" ? "" : i18n.t(`settings.save.${saveState()}` as "settings.save.saving")}
					</span>
				</h2>
				<div class="flex flex-col gap-2">
					<Row label={i18n.t("settings.defaultPersona")}>
						<select
							data-testid="default-persona"
							value={pick(personas(), settings().personaId)}
							onChange={(event) => save({ personaId: event.currentTarget.value === "" ? null : event.currentTarget.value })}
							class="mono border border-border bg-elevated px-2 py-1 text-sm outline-none"
						>
							<option value="">{i18n.t("settings.useBuiltin")}</option>
							<For each={personas()}>{(persona) => <option value={persona.id}>{persona.name}</option>}</For>
						</select>
					</Row>
					<Row label={i18n.t("settings.defaultModel")}>
						<select
							data-testid="default-model"
							value={pick(models(), settings().modelId)}
							onChange={(event) => save({ modelId: event.currentTarget.value === "" ? null : event.currentTarget.value })}
							class="mono border border-border bg-elevated px-2 py-1 text-sm outline-none"
						>
							<option value="">{i18n.t("settings.useConfig")}</option>
							<For each={models()}>{(model) => <option value={model.id}>{model.label}</option>}</For>
						</select>
					</Row>
					<Row label={i18n.t("settings.defaultThinking")}>
						<select
							data-testid="default-thinking"
							value={settings().thinkingLevel ?? ""}
							onChange={(event) => save({ thinkingLevel: event.currentTarget.value === "" ? null : event.currentTarget.value })}
							class="mono border border-border bg-elevated px-2 py-1 text-sm outline-none"
						>
							<option value="">{i18n.t("settings.useBuiltin")}</option>
							<For each={THINKING_LEVELS}>{(level) => <option value={level}>{level}</option>}</For>
						</select>
					</Row>
					<Row label={i18n.t("settings.defaultKeepRecent")}>
						<input
							data-testid="default-keep-recent"
							type="number"
							min="1000"
							step="1000"
							value={settings().keepRecentTokens ?? 20000}
							onInput={(event) => {
								const value = Number.parseInt(event.currentTarget.value, 10);
								if (Number.isSafeInteger(value) && value > 0) save({ keepRecentTokens: value });
							}}
							class="mono w-[120px] border border-border bg-elevated px-2 py-1 text-sm outline-none"
						/>
					</Row>
					<p data-testid="settings-defaults-note" class="text-[11px] text-faint">{i18n.t("settings.defaultsNote")}</p>
				</div>
			</section>
		</main>
	);
}

function Row(props: { label: string; children: JSX.Element }) {
	return (
		<label class="flex items-center gap-2">
			<span class="min-w-0 flex-1 truncate text-sm">{props.label}</span>
			{props.children}
		</label>
	);
}
