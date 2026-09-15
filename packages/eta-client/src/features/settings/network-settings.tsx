import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { NetworkConfig } from "@eta/core/provider-config";
import { apiFetch } from "../../lib/host.ts";
import { useAppI18n } from "../../i18n.ts";

type NetworkView = { revision: string; network: NetworkConfig; runtime?: { source: string; warning?: string } };
export function NetworkSettings(props: { onDirtyChange(value: boolean): void; onBusyChange(value: boolean): void }) {
	const i18n = useAppI18n();
	const controller = new AbortController();
	onCleanup(() => controller.abort());
	const [view, setView] = createSignal<NetworkView>();
	const [draft, setDraft] = createSignal<NetworkConfig>({ mode: "system" });
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal("");
	const [saved, setSaved] = createSignal(false);
	const dirty = () => !!view() && JSON.stringify(draft()) !== JSON.stringify(view()!.network);
	createEffect(() => props.onDirtyChange(dirty()));
	createEffect(() => props.onBusyChange(busy()));
	const load = async () => {
		try {
			const response = await apiFetch("/api/providers/network", { signal: controller.signal });
			if (!response.ok) throw new Error();
			const data = await response.json() as NetworkView;
			if (controller.signal.aborted) return;
			if (!data.network || typeof data.revision !== "string") throw new Error();
			setView(data); setDraft(data.network); setError("");
		} catch { if (!controller.signal.aborted) setError("network.loadFailed"); }
	};
	onMount(() => void load());
	const save = async () => {
		if (!view() || busy()) return;
		setBusy(true); setError(""); setSaved(false);
		try {
			const response = await apiFetch("/api/providers/network", { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: view()!.revision, network: draft() }) });
			const result = await response.json();
			if (controller.signal.aborted) return;
			if (!response.ok) { setError(result.error === "config_changed" ? "network.conflict" : "network.saveFailed"); return; }
			setView({ ...view()!, revision: result.revision, network: result.network }); setDraft(result.network); setSaved(true);
			window.dispatchEvent(new Event("eta:models"));
		} catch { if (!controller.signal.aborted) setError("network.saveFailed"); }
		finally { setBusy(false); }
	};
	return <div class="settings-network" data-testid="network-settings">
		<div class="settings-section-label">{i18n.t("network.title")}</div>
		<p class="settings-hint">{i18n.t("network.description")}</p>
		<fieldset disabled={!view() || busy()}>
			<label class="settings-row"><span>{i18n.t("network.mode")}</span><select data-testid="network-mode" value={draft().mode} onChange={event => { setDraft({ mode: event.currentTarget.value as NetworkConfig["mode"] }); setSaved(false); }}><option value="system">{i18n.t("network.system")}</option><option value="manual">{i18n.t("network.manual")}</option><option value="direct">{i18n.t("network.direct")}</option></select></label>
			<Show when={draft().mode === "manual"}>
				<label class="settings-field">{i18n.t("network.url")}<input data-testid="network-url" placeholder="http://127.0.0.1:1082" value={draft().proxyUrl ?? ""} onInput={event => { setDraft({ ...draft(), proxyUrl: event.currentTarget.value }); setSaved(false); }} /></label>
				<label class="settings-field">{i18n.t("network.bypass")}<input data-testid="network-bypass" placeholder="localhost,127.0.0.1,.example.com" value={draft().noProxy ?? ""} onInput={event => { setDraft({ ...draft(), noProxy: event.currentTarget.value || undefined }); setSaved(false); }} /></label>
			</Show>
			<div class="settings-save"><span role="status">{saved() ? i18n.t("network.saved") : i18n.t("network.restart")}</span><button class="settings-primary" data-testid="network-save" disabled={!dirty()} onClick={() => void save()}>{i18n.t("providers.save")}</button></div>
		</fieldset>
		<Show when={view()?.runtime?.source === "environment"}><p class="settings-hint">{i18n.t("network.environment")}</p></Show>
		<Show when={view()?.runtime?.warning}><p class="settings-hint">{i18n.t(view()?.runtime?.warning === "pac_unsupported" ? "network.pac" : "network.unavailable")}</p></Show>
		<Show when={error()}><div class="settings-error" role="alert">{i18n.t(error() as "network.loadFailed")}<button onClick={() => void load()}>{i18n.t("settings.retry")}</button></div></Show>
	</div>;
}
