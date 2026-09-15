import { For, Show, createSignal, onMount, type JSX } from "solid-js";
import { useAppI18n } from "../i18n.ts";
import { useAppTheme, type ThemePreference } from "../app/theme.tsx";
import { sidebarPrefs, type ProjectSort } from "../lib/prefs.ts";
import { apiFetch } from "../lib/host.ts";
import { ProvidersSettings } from "../features/settings/providers-settings.tsx";
import "../features/settings/settings.css";

type SettingsSection = "general" | "session" | "providers";
interface SettingsFile { personaId?: string; keepRecentTokens?: number }

export function SettingsRow(props: { label: string; note?: string; children: JSX.Element }) {
	return <div class="settings-row"><div class="settings-row-label"><div>{props.label}</div><Show when={props.note}><p>{props.note}</p></Show></div><div class="settings-control">{props.children}</div></div>;
}

export function SettingsPage(props: { onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void } = {}) {
	const i18n = useAppI18n();
	const theme = useAppTheme();
	const [section, setSection] = createSignal<SettingsSection>("general");
	const [notify, setNotify] = createSignal(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
	const [settings, setSettings] = createSignal<SettingsFile>({});
	const [personas, setPersonas] = createSignal<{ id: string; name: string }[]>([]);
	const [saveState, setSaveState] = createSignal<"idle" | "saving" | "saved" | "error">("idle");
	const [loading, setLoading] = createSignal(true);
	const [keepRecent, setKeepRecent] = createSignal("20000");
	const [providersDirty, setProvidersDirty] = createSignal(false);
	const [providersBusy, setProvidersBusy] = createSignal(false);
	const sections = () => [
		{ id: "general" as const, label: i18n.t("settings.general"), icon: "◎" },
		{ id: "session" as const, label: i18n.t("settings.sessions"), icon: "≡" },
		{ id: "providers" as const, label: i18n.t("settings.providers"), icon: "⌘" },
	];
	const reportBusy = () => props.onBusyChange?.(providersBusy() || saveState() === "saving");
	const load = async () => {
		setLoading(true);
		try {
			const [settingsResponse, personasResponse] = await Promise.all([apiFetch("/api/settings"), apiFetch("/api/personas")]);
			if (!settingsResponse.ok || !personasResponse.ok) throw new Error();
			const body = await settingsResponse.json() as SettingsFile;
			const cards = await personasResponse.json();
			if (!body || typeof body !== "object" || !Array.isArray(cards)) throw new Error();
			setSettings(body); setKeepRecent(String(body.keepRecentTokens ?? 20000)); setPersonas(cards);
			setSaveState("idle");
		} catch { setSaveState("error"); }
		finally { setLoading(false); }
	};
	onMount(() => void load());
	let saveTail: Promise<void> = Promise.resolve();
	const save = (patch: Record<string, unknown>) => {
		setSaveState("saving"); reportBusy();
		saveTail = saveTail.then(async () => {
			try {
				const response = await apiFetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
				if (!response.ok) throw new Error();
				setSettings(await response.json() as SettingsFile); setSaveState("saved");
				window.dispatchEvent(new Event("eta:settings"));
			} catch { setSaveState("error"); }
			finally { reportBusy(); }
		});
	};
	return <div class="settings-layout" data-testid="settings-page">
		<nav aria-label={i18n.t("settings.categories")}><For each={sections()}>{item => <button data-testid={`settings-tab-${item.id}`} aria-current={section() === item.id ? "page" : undefined} onClick={() => setSection(item.id)}><span aria-hidden="true">{item.icon}</span>{item.label}</button>}</For></nav>
		<main class="settings-content">
			<select class="settings-mobile" aria-label={i18n.t("settings.categories")} value={section()} onChange={event => setSection(event.currentTarget.value as SettingsSection)}><For each={sections()}>{item => <option value={item.id}>{item.label}</option>}</For></select>
			<section hidden={section() !== "general"}>
				<div class="settings-heading"><h2>{i18n.t("settings.general")}</h2><p>{i18n.t("settings.generalDescription")}</p></div>
				<div class="settings-section-label">{i18n.t("settings.appearance")}</div>
				<SettingsRow label={i18n.t("settings.theme")}><div class="settings-inline"><For each={["system", "light", "dark"] as const}>{value => <button data-testid={`theme-${value}`} aria-pressed={theme.theme === value} classList={{ "settings-selected": theme.theme === value }} onClick={() => theme.setTheme(value as ThemePreference)}>{i18n.t(`theme.${value}`)}</button>}</For></div></SettingsRow>
				<SettingsRow label={i18n.t("settings.language")}><select aria-label={i18n.t("settings.language")} value={i18n.locale} onChange={event => i18n.setLocale(event.currentTarget.value as "en" | "zh-CN")}><option value="zh-CN">简体中文</option><option value="en">English</option></select></SettingsRow>
				<SettingsRow label={i18n.t("settings.notifications")}><button data-testid="notify-enable" disabled={notify() !== "default"} onClick={() => { if (typeof Notification !== "undefined") void Notification.requestPermission().then(setNotify); }}>{i18n.t(`settings.notification.${notify()}` as "settings.notification.default")}</button></SettingsRow>
				<div class="settings-section-label">{i18n.t("settings.sidebar")}</div>
				<SettingsRow label={i18n.t("settings.projectSort")}><select aria-label={i18n.t("settings.projectSort")} value={sidebarPrefs.sort} onChange={event => sidebarPrefs.setSort(event.currentTarget.value as ProjectSort)}><option value="recent">{i18n.t("sidebar.sortRecent")}</option><option value="name">{i18n.t("sidebar.sortName")}</option></select></SettingsRow>
				<Show when={sidebarPrefs.collapsed.length > 0}><SettingsRow label={i18n.t("settings.projectGroups")}><button data-testid="sidebar-expand-all" onClick={() => sidebarPrefs.setCollapsed([])}>{i18n.t("settings.expandGroups", { n: sidebarPrefs.collapsed.length })}</button></SettingsRow></Show>
			</section>
			<section hidden={section() !== "session"}>
				<div class="settings-heading"><h2>{i18n.t("settings.sessions")}</h2><p>{i18n.t("settings.sessionDescription")}</p></div>
				<Show when={!loading()} fallback={<p class="settings-hint">{i18n.t("settings.loading")}</p>}>
					<SettingsRow label={i18n.t("settings.defaultPersona")}><select data-testid="default-persona" aria-label={i18n.t("settings.defaultPersona")} value={personas().some(persona => persona.id === settings().personaId) ? settings().personaId : ""} onChange={event => save({ personaId: event.currentTarget.value || null })}><option value="">{i18n.t("settings.useBuiltin")}</option><For each={personas()}>{persona => <option value={persona.id}>{persona.name}</option>}</For></select></SettingsRow>
					<SettingsRow label={i18n.t("settings.defaultKeepRecent")} note={i18n.t("settings.keepRecentNote")}><div class="settings-inline"><input data-testid="default-keep-recent" aria-label={i18n.t("settings.defaultKeepRecent")} type="number" min="1000" step="1000" value={keepRecent()} onInput={event => setKeepRecent(event.currentTarget.value)} onChange={() => {
						const value = Number(keepRecent());
						if (!Number.isSafeInteger(value) || value < 1000) { setSaveState("error"); return; }
						save({ keepRecentTokens: value });
					}} /><span class="mono">tokens</span></div></SettingsRow>
				</Show>
				<p class="settings-hint">{i18n.t("settings.defaultsNote")}</p>
				<div data-testid="settings-save-state" class="settings-hint" role="status">{saveState() !== "idle" && i18n.t(`settings.save.${saveState()}` as "settings.save.saving" | "settings.save.saved" | "settings.save.error")}</div>
				<Show when={saveState() === "error"}><button onClick={() => void load()}>{i18n.t("settings.retry")}</button></Show>
			</section>
			<section hidden={section() !== "providers"}>
				<ProvidersSettings onDirtyChange={value => { setProvidersDirty(value); props.onDirtyChange?.(providersDirty()); }} onBusyChange={value => { setProvidersBusy(value); reportBusy(); }} />
			</section>
		</main>
	</div>;
}
