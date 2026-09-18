import { For, Index, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import {
	effectiveModel, isCustomKind, modelSupportsVision, modelThinkingLevels, MODEL_THINKING_LEVELS, BUILTIN_PROVIDER_PRESETS, providerPreset,
	type CodexLoginView, type EtaModelConfig, type ModelCapabilities, type ProviderHeaders, type ProviderInput, type ProviderSummary, type ProvidersView, type ProviderKind,
} from "@eta/core/provider-config";
import { useAppI18n } from "../../i18n.ts";
import { apiFetch } from "../../lib/host.ts";

const BUILTIN_KINDS = Object.keys(BUILTIN_PROVIDER_PRESETS) as (keyof typeof BUILTIN_PROVIDER_PRESETS)[];

function providerDescriptionKey(kind: ProviderKind) {
	if (kind === "openai-codex") return "providers.codexDescription" as const;
	if (kind === "kimi-coding") return "providers.kimiDescription" as const;
	if (kind === "deepseek") return "providers.deepseekDescription" as const;
	if (kind === "zai-coding-cn") return "providers.zaiCodingCnDescription" as const;
	if (kind === "zai") return "providers.zaiDescription" as const;
	return "providers.customDescription" as const;
}

/** Editor rows for custom request headers; an empty value is saved as null = “do not send”. */
type HeaderRow = { name: string; value: string };

function headerRowsFrom(headers: ProviderHeaders | undefined | null): HeaderRow[] {
	return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value: value ?? "" }));
}

function headersFromRows(rows: HeaderRow[]): ProviderHeaders | undefined {
	const out: ProviderHeaders = {};
	for (const row of rows) {
		const name = row.name.trim();
		if (name.length === 0) continue;
		for (const saved of Object.keys(out)) {
			if (saved.toLowerCase() === name.toLowerCase()) delete out[saved];
		}
		out[name] = row.value.trim().length === 0 ? null : row.value.trim();
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

async function providerRequest<T>(path: string, body?: unknown, method = "POST", signal?: AbortSignal): Promise<T> {
	const response = await apiFetch(path, body === undefined
		? { signal }
		: { method, signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	if (response.status === 404 && path.includes("/api/providers/codex/")) throw new Error("codex_backend_outdated");
	let result: unknown;
	try { result = await response.json(); } catch { throw new Error("connection_failed"); }
	if (!response.ok) throw new Error((result as { error?: string })?.error ?? "connection_failed");
	return result as T;
}

export function ProvidersSettings(props: { onDirtyChange(dirty: boolean): void; onBusyChange(busy: boolean): void; apiBase?: string }) {
	const i18n = useAppI18n();
	const api = (path: string) => `${props.apiBase ?? ""}${path}`;
	const [view, setView] = createSignal<ProvidersView>();
	const [draft, setDraft] = createSignal<ProviderInput>();
	const [baseline, setBaseline] = createSignal("");
	const [hasKey, setHasKey] = createSignal(false);
	const [headerRows, setHeaderRows] = createSignal<HeaderRow[]>([]);
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal("");
	const [status, setStatus] = createSignal<"" | "connected" | "saved">("");
	const [deleteConfirm, setDeleteConfirm] = createSignal(false);
	const [backConfirm, setBackConfirm] = createSignal(false);
	const [login, setLogin] = createSignal<CodexLoginView>();
	const [loginAnswer, setLoginAnswer] = createSignal("");
	const [answerBusy, setAnswerBusy] = createSignal(false);
	let loginTimer: ReturnType<typeof setTimeout> | undefined;
	const cancelLogin = () => { const id = login()?.id; clearTimeout(loginTimer); setLogin(undefined); setLoginAnswer(""); if (id) void providerRequest(api("/api/providers/codex/cancel"), { id }).catch(() => {}); };
	let controller: AbortController | undefined;
	let generation = 0;
	const dirty = () => draft() !== undefined && JSON.stringify(draft()) !== baseline();
	const editingExisting = () => view()?.providers.some(provider => provider.id === draft()?.id) ?? false;
	createEffect(() => props.onDirtyChange(dirty()));
	createEffect(() => props.onBusyChange(busy()));
	onCleanup(() => { generation += 1; controller?.abort(); cancelLogin(); props.onDirtyChange(false); });

	const message = () => {
		const key = `providers.error.${error()}`;
		const translated = i18n.t(key as "providers.error.connection_failed");
		return translated === key ? i18n.t("providers.error.connection_failed") : translated;
	};
	const load = async () => {
		try {
			const result = await providerRequest<ProvidersView>(api("/api/providers"));
			if (!result || !Array.isArray(result.providers)) throw new Error("invalid_saved_config");
			setView(result); setError("");
		} catch (cause) { setError(cause instanceof Error ? cause.message : "connection_failed"); }
	};
	onMount(() => {
		void load();
		const changed = () => { if (!dirty() && !busy() && !draft()) void load(); };
		window.addEventListener("eta:models", changed);
		onCleanup(() => window.removeEventListener("eta:models", changed));
	});
	const changed = () => window.dispatchEvent(new Event("eta:models"));
	const update = (patch: Partial<ProviderInput>) => {
		setDraft(previous => previous ? { ...previous, ...patch } : previous);
		setStatus(""); setDeleteConfirm(false);
	};
	const updateModel = (index: number, patch: Partial<EtaModelConfig>) => update({ models: draft()!.models.map((model, i) => i === index ? { ...model, ...patch } : model) });
	const editHeaders = (rows: HeaderRow[]) => { setHeaderRows(rows); update({ headers: headersFromRows(rows) }); };
	const changeHeader = (index: number, patch: Partial<HeaderRow>) => editHeaders(headerRows().map((row, i) => i === index ? { ...row, ...patch } : row));
	const removeHeader = (index: number) => editHeaders(headerRows().filter((_, i) => i !== index));
	const addHeader = () => editHeaders([...headerRows(), { name: "", value: "" }]);
	const edit = (provider: ProviderSummary | ProviderKind) => {
		generation += 1; controller?.abort(); cancelLogin();
		let next: ProviderInput;
		if (typeof provider === "string") {
			const id = !isCustomKind(provider) && !view()?.providers.some(item => item.id === provider)
				? provider : `${isCustomKind(provider) ? "custom" : provider}-${crypto.randomUUID().slice(0, 8)}`;
			next = { id, kind: provider, baseUrl: providerPreset(provider)?.baseUrl ?? "", models: [] };
			setHasKey(false);
			setHeaderRows([]);
		} else {
			next = { id: provider.id, kind: provider.kind, name: provider.name, baseUrl: provider.baseUrl, headers: provider.headers, models: structuredClone(provider.models) };
			setHasKey(provider.hasApiKey);
			setHeaderRows(headerRowsFrom(provider.headers));
		}
		setDraft(next); setBaseline(JSON.stringify(next)); setError(""); setStatus(""); setDeleteConfirm(false); setBackConfirm(false);
	};
	const back = () => {
		if (busy()) return;
		cancelLogin();
		if (dirty()) setBackConfirm(true);
		else setDraft(undefined);
	};
	const discover = async () => {
		if (!draft() || busy()) return;
		const attempt = ++generation;
		controller?.abort(); controller = new AbortController();
		setBusy(true); setError(""); setStatus("");
		try {
			const result = await providerRequest<{ models: EtaModelConfig[] }>(api("/api/providers/discover"), { provider: draft() }, "POST", controller.signal);
			if (attempt !== generation) return;
			if (!Array.isArray(result.models)) throw new Error("invalid_models_response");
			update({ models: result.models }); setStatus("connected");
		} catch (cause) {
			if (attempt === generation) setError(cause instanceof Error ? cause.message : "connection_failed");
		} finally { if (attempt === generation) setBusy(false); }
	};
	const startLogin = async (method: "browser" | "device_code" = "browser") => {
		if (!draft() || busy()) return;
		cancelLogin(); setError(""); setBusy(true);
		const attempt = generation;
		try {
			const started = await providerRequest<CodexLoginView>(api("/api/providers/codex/login"), { providerId: draft()!.id, method });
			if (attempt !== generation) { void providerRequest(api("/api/providers/codex/cancel"), { id: started.id }); return; }
			setLogin(started);
			const poll = async () => {
				try {
					const current = await providerRequest<CodexLoginView>(api("/api/providers/codex/status"), { id: started.id });
					if (login()?.id !== started.id) return;
					setLogin(current);
					if (current.status === "complete") { setLogin(undefined); setLoginAnswer(""); await discover(); }
					else if (current.status === "failed") { setLogin(undefined); setError("codex_login_failed"); }
					else loginTimer = setTimeout(() => void poll(), 1500);
				} catch (cause) { if (login()?.id === started.id) { cancelLogin(); setError(cause instanceof Error ? cause.message : "connection_failed"); } }
			};
			loginTimer = setTimeout(() => void poll(), 500);
		} catch (cause) { setError(cause instanceof Error ? cause.message : "connection_failed"); }
		finally { if (attempt === generation) setBusy(false); }
	};

	const answerLogin = async () => {
		const flow = login();
		if (!flow?.manualPromptId || !loginAnswer().trim() || answerBusy()) return;
		const attempt = generation;
		setAnswerBusy(true); setError("");
		try {
			await providerRequest(api("/api/providers/codex/answer"), { id: flow.id, promptId: flow.manualPromptId, value: loginAnswer().trim() });
			if (attempt === generation) setLoginAnswer("");
		} catch (cause) { if (attempt === generation) setError(cause instanceof Error ? cause.message : "connection_failed"); }
		finally { setAnswerBusy(false); }
	};

	const accept = (result: ProvidersView) => {
		setView(result);
		const current = result.providers.find(provider => provider.id === draft()?.id);
		if (current) edit(current); else setDraft(undefined);
		setStatus("saved"); changed();
	};
	const save = async () => {
		if (!draft() || !view() || busy()) return;
		setBusy(true); setError("");
		try { accept(await providerRequest<ProvidersView>(api("/api/providers"), { revision: view()!.revision, provider: draft() })); }
		catch (cause) { setError(cause instanceof Error ? cause.message : "save_failed"); }
		finally { setBusy(false); }
	};
	const remove = async () => {
		if (!draft() || !view() || busy()) return;
		setBusy(true); setError("");
		try { accept(await providerRequest<ProvidersView>(api(`/api/providers/${encodeURIComponent(draft()!.id)}`), { revision: view()!.revision }, "DELETE")); }
		catch (cause) { setError(cause instanceof Error ? cause.message : "save_failed"); }
		finally { setBusy(false); }
	};
	const defaultModel = async (value: string) => {
		if (!view() || busy()) return;
		setBusy(true); setError("");
		try { setView(await providerRequest<ProvidersView>(api("/api/providers/default"), { revision: view()!.revision, defaultModel: value || null })); changed(); }
		catch (cause) { setError(cause instanceof Error ? cause.message : "save_failed"); }
		finally { setBusy(false); }
	};
	const ErrorNotice = () => <Show when={error()}><div class="settings-error" data-testid="provider-error" role="alert">{message()}<Show when={!draft()}><button onClick={() => void load()}>{i18n.t("settings.retry")}</button></Show><Show when={error() === "config_changed"}><button disabled={busy()} onClick={async () => { await load(); setError("config_changed"); }}>{i18n.t("providers.reloadRevision")}</button></Show></div></Show>;
	const title = (provider: ProviderSummary) => provider.name ?? (providerPreset(provider.kind)?.name ?? provider.id);
	return <div data-testid="providers-settings">
		<Show when={draft()} fallback={<>
			<div class="settings-heading"><h2>{i18n.t("settings.providers")}</h2><p>{i18n.t("providers.description")}</p></div>
			<Show when={view()} fallback={<Show when={!error()}><p class="settings-hint">{i18n.t("settings.loading")}</p></Show>}>
				{current => <>
					<label class="settings-default"><span>{i18n.t("settings.defaultModel")}</span><select data-testid="default-model" value={current().defaultModel ?? ""} disabled={busy()} onChange={event => void defaultModel(event.currentTarget.value)}><option value="">{i18n.t("providers.autoDefault")}</option><For each={current().providers}>{provider => <optgroup label={title(provider)}><For each={provider.models}>{model => <option value={`${provider.id}:${model.id}`}>{effectiveModel(model).name ?? model.id}</option>}</For></optgroup>}</For></select></label>
					<Show when={current().providers.length > 0}><div class="settings-section-label">{i18n.t("providers.configured")}</div><For each={current().providers}>{provider => <button class="settings-provider" data-testid={`provider-${provider.id}`} onClick={() => edit(provider)}><ProviderLogo kind={provider.kind} /><span><strong>{title(provider)}</strong><small>{i18n.t("providers.modelCount", { n: provider.models.length })} · {provider.kind === "openai-codex" ? i18n.t("providers.codexAccount") : provider.hasApiKey ? i18n.t("providers.keyConfigured") : i18n.t("providers.noKey")}</small></span><span class="settings-provider-action">{i18n.t("providers.configure")} →</span></button>}</For></Show>
					<div class="settings-section-label">{i18n.t("providers.add")}</div>
					<For each={BUILTIN_KINDS}>{kind => <Show when={!current().providers.some(provider => provider.kind === kind)}><button class="settings-provider" data-testid={`provider-add-${kind === "kimi-coding" ? "kimi" : kind}`} onClick={() => edit(kind)}><ProviderLogo kind={kind} /><span><strong>{providerPreset(kind)!.name}</strong><small>{i18n.t(providerDescriptionKey(kind))}</small></span><span class="settings-provider-action">{i18n.t("providers.connect")} →</span></button></Show>}</For>
					<button class="settings-provider" data-testid="provider-add-custom" onClick={() => edit("openai-compatible")}><ProviderLogo kind="openai-compatible" /><span><strong>{i18n.t("providers.custom")}</strong><small>{i18n.t("providers.customDescription")}</small></span><span class="settings-provider-action">{i18n.t("providers.addAction")} →</span></button>
				</>}
			</Show>
		</>}>
			{current => <>
				<button class="settings-back" disabled={busy()} onClick={back}>← {i18n.t("settings.providers")}</button>
				<Show when={backConfirm()}><div class="settings-discard" role="alert"><span>{i18n.t("settings.unsaved")}</span><button onClick={() => setBackConfirm(false)}>{i18n.t("settings.keepEditing")}</button><button onClick={() => { setDraft(undefined); setBackConfirm(false); }}>{i18n.t("settings.discard")}</button></div></Show>
				<div class="settings-heading settings-inline"><ProviderLogo kind={current().kind} /><div><h2>{providerPreset(current().kind)?.name ?? i18n.t("providers.custom")}</h2><p>{i18n.t(providerDescriptionKey(current().kind))}</p></div></div>
				<Show when={current().kind === "openai-codex"}><section class="settings-codex-auth">
					<div class="settings-row"><span>{i18n.t("providers.codexAccount")}</span><div class="settings-inline"><button data-testid="codex-login" disabled={busy() || !!login()} onClick={() => void startLogin()}>{i18n.t("providers.codexLogin")}</button></div></div>
					<p class="settings-hint">{i18n.t("providers.codexCatalogHint")}</p>
					<Show when={login()}>{flow => <div class="settings-codex-login" role="status">
						<Show when={flow().url} fallback={<span class="settings-hint">{i18n.t("providers.connecting")}</span>}>
							<Show when={flow().userCode}><div class="settings-codex-code"><span class="settings-hint">{i18n.t("providers.codexCode")}</span><code>{flow().userCode}</code></div></Show>
							<p class="settings-hint settings-codex-instructions">{i18n.t(flow().method === "device_code" ? "providers.codexDeviceHint" : "providers.codexBrowserHint")}</p>
						</Show>
						<div class="settings-codex-actions"><Show when={flow().url}><a href={flow().url} target="_blank" rel="noopener noreferrer">{i18n.t("providers.codexOpenLogin")} ↗</a></Show><button onClick={cancelLogin}>{i18n.t("providers.cancel")}</button></div>
						<Show when={flow().manualPromptId}><details class="settings-codex-manual"><summary>{i18n.t("providers.codexManualTitle")}</summary><label class="settings-field">{i18n.t("providers.codexManualHint")}<input data-testid="codex-login-answer" autocomplete="off" spellcheck={false} value={loginAnswer()} onInput={event => setLoginAnswer(event.currentTarget.value)} /></label><button disabled={answerBusy() || !loginAnswer().trim()} onClick={() => void answerLogin()}>{i18n.t("providers.codexContinue")}</button></details></Show>
					</div>}</Show>
					<Show when={!login()}><button class="settings-text-button" data-testid="codex-device-login" disabled={busy()} onClick={() => void startLogin("device_code")}>{i18n.t("providers.codexDeviceAlternative")}</button></Show>
				</section></Show>
				<fieldset disabled={busy() || !!login()}>
					<Show when={isCustomKind(current().kind)}><label class="settings-field">{i18n.t("providers.name")}<input data-testid="provider-name" value={current().name ?? ""} onInput={event => update({ name: event.currentTarget.value || undefined })} /></label><label class="settings-field">Base URL<input data-testid="provider-url" placeholder="https://example.com/v1" value={current().baseUrl} onInput={event => update({ baseUrl: event.currentTarget.value })} /></label><label class="settings-field">{i18n.t("providers.protocol")}<select data-testid="provider-protocol" value={current().kind} onChange={event => update({ kind: event.currentTarget.value as ProviderKind })}><option value="openai-compatible">{i18n.t("providers.protocolChatCompletions")}</option><option value="openai-responses">{i18n.t("providers.protocolResponses")}</option></select></label></Show>
					<Show when={current().kind !== "openai-codex"}><label class="settings-field">API Key<input data-testid="provider-key" type="password" autocomplete="off" value={current().apiKey ?? ""} placeholder={hasKey() ? i18n.t("providers.keepKey") : i18n.t("providers.enterKey")} onInput={event => update({ apiKey: event.currentTarget.value || undefined })} /></label></Show>
					<Show when={hasKey() && isCustomKind(current().kind)}><button class="settings-text-button" onClick={() => update({ apiKey: null })}>{current().apiKey === null ? i18n.t("providers.keyWillClear") : i18n.t("providers.clearKey")}</button></Show>
					<Show when={current().kind !== "openai-codex"}><details class="settings-headers" data-testid="provider-headers" open={headerRows().length > 0}>
						<summary>{i18n.t("providers.headers")}</summary>
						<Index each={headerRows()}>{(row, index) => <div class="settings-header-row">
							<input data-testid={`provider-header-name-${index}`} class="mono" spellcheck={false} placeholder="User-Agent" aria-label={`${i18n.t("providers.headerName")} ${index + 1}`} value={row().name} onInput={event => changeHeader(index, { name: event.currentTarget.value })} />
							<input data-testid={`provider-header-value-${index}`} class="mono" spellcheck={false} placeholder="eta-agent/1" aria-label={`${i18n.t("providers.headerValue")} ${index + 1}`} value={row().value} onInput={event => changeHeader(index, { value: event.currentTarget.value })} />
							<span class="settings-header-tail">
								<Show when={row().name.trim().length > 0 && row().value.trim().length === 0}><span class="settings-header-suppressed" data-testid={`provider-header-suppressed-${index}`}>{i18n.t("providers.headerSuppressed")}</span></Show>
								<button class="settings-text-button" data-testid={`provider-header-remove-${index}`} aria-label={i18n.t("providers.removeHeader", { n: index + 1 })} onClick={() => removeHeader(index)}>✕</button>
							</span>
						</div>}</Index>
						<button class="settings-add-header" data-testid="provider-add-header" onClick={addHeader}>＋ {i18n.t("providers.addHeader")}</button>
						<p class="settings-hint">{i18n.t("providers.headersHint")}</p>
					</details></Show>
					<div class="settings-inline"><button data-testid="provider-discover" class="settings-primary" onClick={() => void discover()}>{busy() ? i18n.t("providers.connecting") : current().models.length > 0 ? i18n.t("providers.refresh") : i18n.t("providers.connectModels")}</button><span class="settings-hint" aria-live="polite">{status() === "connected" ? i18n.t("providers.connected", { n: current().models.length }) : ""}</span></div>
					<Show when={current().models.length > 0}><div class="settings-section-label">{i18n.t("providers.models")}</div></Show>
					<Index each={current().models}>{(model, index) => <ModelEditor model={model()} custom={isCustomKind(current().kind)} onUpdate={patch => updateModel(index, patch)} onRemove={() => update({ models: current().models.filter((_, i) => i !== index) })} />}</Index>
					<Show when={isCustomKind(current().kind)}><button data-testid="provider-add-model" class="settings-add-model" onClick={() => update({ models: [...current().models, { id: "", overrides: { contextWindow: 128000, maxTokens: 8192, input: ["text"], reasoning: false } }] })}>＋ {i18n.t("providers.addModel")}</button></Show>
				</fieldset>
				<div class="settings-provider-actions">
					<Show when={deleteConfirm()} fallback={
						<div class="settings-save"><Show when={editingExisting()}><button data-testid="provider-delete" class="settings-danger" disabled={busy()} onClick={() => { setError(""); setDeleteConfirm(true); }}>{i18n.t("providers.delete")}</button></Show><span role="status">{status() === "saved" ? i18n.t("settings.save.saved") : dirty() ? i18n.t("providers.unsaved") : ""}</span><button data-testid="provider-save" class="settings-primary" disabled={busy() || !dirty() || current().models.length === 0} onClick={() => void save()}>{busy() ? i18n.t("settings.save.saving") : i18n.t("providers.save")}</button></div>
					}>
						<div class="settings-delete-confirm" data-testid="provider-delete-confirm" role="alert">
							<span>{i18n.t("providers.deleteConfirm")}</span>
							<div class="settings-inline"><button data-testid="provider-delete-cancel" ref={element => queueMicrotask(() => { if (element.isConnected) element.focus(); })} disabled={busy()} onClick={() => setDeleteConfirm(false)}>{i18n.t("providers.cancel")}</button><button data-testid="provider-delete-submit" class="settings-danger" disabled={busy()} onClick={() => void remove()}>{busy() ? i18n.t("providers.deleting") : i18n.t("providers.delete")}</button></div>
						</div>
					</Show>
					<ErrorNotice />
				</div>
			</>}
		</Show>
		<Show when={!draft()}><ErrorNotice /></Show>
	</div>;
}

function ProviderLogo(props: { kind: ProviderInput["kind"] }) {
	return <span class="settings-provider-mark" aria-hidden="true"><Show when={providerPreset(props.kind)?.logo} fallback={<span class="settings-plus" />}>{logo => <img class="provider-logo" classList={{ "provider-kimi-logo": props.kind === "kimi-coding" }} src={`/providers/${logo()}`} alt="" />}</Show></span>;
}

function ModelEditor(props: { model: EtaModelConfig; custom: boolean; onUpdate(patch: Partial<EtaModelConfig>): void; onRemove(): void }) {
	const i18n = useAppI18n();
	const [expanded, setExpanded] = createSignal(!props.model.id);
	const effective = () => effectiveModel(props.model);
	const levels = () => modelThinkingLevels(props.model);
	const override = (patch: ModelCapabilities) => props.onUpdate({ overrides: { ...props.model.overrides, ...patch } });
	return <div class="settings-model">
		<div class="settings-model-title"><strong class="mono">{effective().name ?? (props.model.id || i18n.t("providers.newModel"))}</strong><button class="settings-text-button" aria-label={i18n.t("providers.removeModel", { id: props.model.id })} onClick={props.onRemove}>✕</button></div>
		<Show when={effective().name && effective().name !== props.model.id}><p class="settings-hint mono">{props.model.id}</p></Show>
		<div class="settings-model-meta"><span>{effective().contextWindow ? `${effective().contextWindow!.toLocaleString()} tokens` : i18n.t("providers.contextUnknown")}</span><Show when={modelSupportsVision(effective()) === true}><span>{i18n.t("providers.vision")}</span></Show><Show when={effective().reasoning}><span>{i18n.t("providers.reasoning")}</span></Show></div>
		<label class="settings-row"><span>{i18n.t("providers.defaultThinking")}</span><select aria-label={`${i18n.t("providers.defaultThinking")} ${props.model.id}`} value={props.model.defaultThinking ?? ""} disabled={levels().length === 0 || (levels().length === 1 && levels()[0] === "off")} onChange={event => props.onUpdate({ defaultThinking: event.currentTarget.value === "" ? undefined : event.currentTarget.value as EtaModelConfig["defaultThinking"] })}><option value="">{i18n.t("providers.followProvider")}{effective().providerDefaultEffort ? ` (${effective().providerDefaultEffort})` : ""}</option><For each={levels()}>{level => <option value={level}>{level}</option>}</For></select></label>
		<Show when={props.custom}><details open={expanded()} onToggle={event => setExpanded(event.currentTarget.open)}><summary>{i18n.t("providers.modelSettings")}</summary><div class="settings-model-fields">
			<label class="settings-field">Model ID<input data-testid="custom-model-id" value={props.model.id} onInput={event => props.onUpdate({ id: event.currentTarget.value })} /></label>
			<label class="settings-field">{i18n.t("providers.name")}<input value={effective().name ?? ""} onInput={event => override({ name: event.currentTarget.value || undefined })} /></label>
			<label class="settings-field">{i18n.t("providers.contextWindow")}<input type="number" min="1" value={effective().contextWindow ?? ""} onInput={event => override({ contextWindow: event.currentTarget.value ? Number(event.currentTarget.value) : undefined })} /></label>
			<label class="settings-field">{i18n.t("providers.maxTokens")}<input type="number" min="1" value={effective().maxTokens ?? ""} onInput={event => override({ maxTokens: event.currentTarget.value ? Number(event.currentTarget.value) : undefined })} /></label>
			<label class="settings-check"><input type="checkbox" checked={modelSupportsVision(effective()) ?? false} onChange={event => override({ input: event.currentTarget.checked ? ["text", "image"] : ["text"] })} />{i18n.t("providers.vision")}</label>
			<label class="settings-check"><input type="checkbox" checked={effective().reasoning ?? false} onChange={event => { override(event.currentTarget.checked ? { reasoning: true, thinkingMode: "both", reasoningEfforts: ["low", "medium", "high"], providerDefaultEffort: "high" } : { reasoning: false, thinkingMode: "no", reasoningEfforts: [], providerDefaultEffort: undefined }); props.onUpdate({ defaultThinking: undefined }); }} />{i18n.t("providers.reasoning")}</label>
			<Show when={effective().reasoning}><label class="settings-check"><input type="checkbox" checked={effective().thinkingMode === "both"} onChange={event => { override({ thinkingMode: event.currentTarget.checked ? "both" : "only" }); props.onUpdate({ defaultThinking: undefined }); }} />{i18n.t("providers.canDisableThinking")}</label><div class="settings-field"><span>{i18n.t("providers.efforts")}</span><div class="settings-efforts"><For each={MODEL_THINKING_LEVELS.filter(level => level !== "off")}>{level => <label class="settings-check"><input type="checkbox" checked={effective().reasoningEfforts?.includes(level) ?? false} onChange={event => {
				const next = event.currentTarget.checked ? [...(effective().reasoningEfforts ?? []), level] : (effective().reasoningEfforts ?? []).filter(item => item !== level);
				override({ reasoningEfforts: next, providerDefaultEffort: next.includes(effective().providerDefaultEffort!) ? effective().providerDefaultEffort : next[0] }); props.onUpdate({ defaultThinking: undefined });
			}} />{level}</label>}</For></div></div><label class="settings-field">{i18n.t("providers.providerDefault")}<select value={effective().providerDefaultEffort ?? ""} onChange={event => override({ providerDefaultEffort: event.currentTarget.value as ModelCapabilities["providerDefaultEffort"] })}><option value="">{i18n.t("providers.unknown")}</option><For each={effective().reasoningEfforts ?? []}>{level => <option value={level}>{level}</option>}</For></select></label></Show>
			<p class="settings-hint">{i18n.t("providers.overridesNote")}</p>
		</div></details></Show>
	</div>;
}
