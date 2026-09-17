import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { useAppI18n } from "../../i18n.ts";
import { isRemoteViewList, remoteRequest, RemoteRequestError, type RemoteHostKey, type RemoteView } from "../../lib/remotes.ts";
import { ProvidersSettings } from "./providers-settings.tsx";
import { RemoteDirectoryPicker } from "../sessions/remote-directory.tsx";

interface Draft {
	id?: string;
	name: string;
	host: string;
	user: string;
	port: string;
	identityFile: string;
	autoConnect: boolean;
}

const emptyDraft = (): Draft => ({ name: "", host: "", user: "", port: "", identityFile: "", autoConnect: false });

export function RemotesSettings(props: { onDirtyChange(dirty: boolean): void; onBusyChange(busy: boolean): void }) {
	const i18n = useAppI18n();
	const [remotes, setRemotes] = createSignal<RemoteView[]>([]);
	const [hosts, setHosts] = createSignal<string[]>([]);
	const [error, setError] = createSignal("");
	const [busy, setBusy] = createSignal(false);
	const [draft, setDraft] = createSignal<Draft | undefined>();
	const [providersDirty, setProvidersDirty] = createSignal(false);
	const [openId, setOpenId] = createSignal<string | undefined>();
	const [confirmInstall, setConfirmInstall] = createSignal<string>();
	const [hostKey, setHostKey] = createSignal<{ id: string; key: RemoteHostKey; resume: () => Promise<unknown> }>();
	const [trustError, setTrustError] = createSignal("");
	const [confirmStop, setConfirmStop] = createSignal<string>();
	const [forwardPort, setForwardPort] = createSignal("");
	const [forwardLocal, setForwardLocal] = createSignal("");
	const [projectPath, setProjectPath] = createSignal("");
	const dirty = () => draft() !== undefined || providersDirty();
	createEffect(() => props.onDirtyChange(dirty()));
	createEffect(() => props.onBusyChange(busy()));
	const accept = (body: unknown) => {
		if (!isRemoteViewList(body)) throw new Error("invalid_saved_config");
		setRemotes(body);
		setError("");
	};
	const load = async () => {
		try {
			accept(await remoteRequest("/api/remotes"));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "connection_failed");
		}
	};
	onMount(() => {
		void load();
		void remoteRequest<string[]>("/api/remotes/discover")
			.then((list) => setHosts(Array.isArray(list) ? list : []))
			.catch(() => undefined);
		const onRemotes = () => void load();
		window.addEventListener("eta:remotes", onRemotes);
		onCleanup(() => window.removeEventListener("eta:remotes", onRemotes));
	});
	const run = async (work: () => Promise<unknown>) => {
		setBusy(true);
		setError("");
		try {
			const result = await work();
			if (isRemoteViewList(result)) accept(result);
			else await load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "connection_failed");
		} finally {
			setBusy(false);
		}
	};
	const connectAction = (id: string, action: "test" | "connect" | "install") => {
		const work = () => remoteRequest(`/api/remotes/${id}/${action}`, action === "install" ? { confirm: true } : {});
		void run(async () => {
			try { return await work(); }
			catch (cause) {
				if (cause instanceof RemoteRequestError && cause.kind === "host-key") {
					const key = await remoteRequest<RemoteHostKey>(`/api/remotes/${id}/host-key`, {});
					setTrustError("");
					setHostKey({ id, key, resume: work });
					return;
				}
				if (cause instanceof RemoteRequestError && cause.kind === "host-key-changed")
					throw new Error(i18n.t("remote.hostKeyChanged"));
				throw cause;
			}
		});
	};
	const trust = async () => {
		const pending = hostKey();
		if (!pending || busy()) return;
		setBusy(true);
		setTrustError("");
		try {
			await remoteRequest(`/api/remotes/${pending.id}/trust-host`, { challengeId: pending.key.challengeId });
			setHostKey(undefined);
			const result = await pending.resume();
			if (isRemoteViewList(result)) accept(result);
			else await load();
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : "connection_failed";
			if (hostKey()) setTrustError(message);
			else setError(message);
		} finally { setBusy(false); }
	};

	const saveDraft = async (current: Draft) => {
		setBusy(true);
		setError("");
		try {
			accept(
				await remoteRequest("/api/remotes", {
					...(current.id ? { id: current.id } : {}),
					name: current.name,
					host: current.host,
					...(current.user ? { user: current.user } : {}),
					...(current.port ? { port: Number(current.port) } : {}),
					...(current.identityFile ? { identityFile: current.identityFile } : {}),
					autoConnect: current.autoConnect,
				}),
			);
			setDraft(undefined);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "connection_failed");
		} finally {
			setBusy(false);
		}
	};
	return (
		<div data-testid="remotes-settings">
			<Show when={hostKey()}>{(pending) => <Portal>
				<HostKeyDialog value={pending().key} busy={busy()} error={trustError()}
					onCancel={() => { if (!busy()) setHostKey(undefined); }} onTrust={() => void trust()} />
			</Portal>}</Show>
			<div class="settings-heading">
				<h2>{i18n.t("remote.title")}</h2>
				<p>{i18n.t("remote.description")}</p>
			</div>
			<Show when={error()}>
				<p class="settings-hint" data-testid="remotes-error" role="alert">
					{error()}
				</p>
			</Show>
			<div class="flex items-center gap-2 py-2">
				<button data-testid="remote-add" class="border border-border px-2 py-1 text-xs" disabled={busy()} onClick={() => setDraft(emptyDraft())}>
					{i18n.t("remote.add")}
				</button>
			</div>
			<Show when={draft()}>
				{(current) => (
					<Portal>
						<RemoteDraftDialog
							initial={current()}
							hosts={hosts()}
							busy={busy()}
							error={error()}
							onCancel={() => { if (!busy()) setDraft(undefined); }}
							onSave={(value) => void saveDraft(value)}
						/>
					</Portal>
				)}
			</Show>
			<For each={remotes()}>
				{(remote) => (
					<div class="mt-2 border border-border" data-testid={`remote-row-${remote.id}`}>
						<div class="flex flex-wrap items-center gap-2 p-2">
							<button class="min-w-0 flex-1 text-left" data-testid={`remote-open-${remote.id}`} onClick={() => setOpenId((current) => (current === remote.id ? undefined : remote.id))}>
								<div class="truncate text-sm">{remote.name}</div>
								<div class="truncate font-mono text-[11px] text-muted">{remote.host}</div>
							</button>
							<span data-testid={`remote-status-${remote.id}`} class="border border-border-strong px-1 text-[10px] uppercase tracking-wider text-muted">
								{i18n.t(`remote.status.${remote.status}` as "remote.status.disconnected")}
							</span>
							<button data-testid={`remote-test-${remote.id}`} disabled={busy()} class="border border-border px-2 py-1 text-[11px]" onClick={() => connectAction(remote.id, "test")}>
								{i18n.t("remote.test")}
							</button>
							<Show when={remote.status !== "connected" && remote.status !== "connecting" && remote.status !== "checking" && remote.status !== "installing" && remote.status !== "reconnecting"}>
								<button data-testid={`remote-connect-${remote.id}`} disabled={busy()} class="border border-border px-2 py-1 text-[11px]" onClick={() => connectAction(remote.id, "connect")}>
									{i18n.t("remote.connect")}
								</button>
							</Show>
							<Show when={remote.status === "connected" || remote.status === "reconnecting"}>
								<button data-testid={`remote-disconnect-${remote.id}`} disabled={busy()} title={i18n.t("remote.disconnectHint")} class="border border-border px-2 py-1 text-[11px]" onClick={() => void run(() => remoteRequest(`/api/remotes/${remote.id}/disconnect`, {}))}>
									{i18n.t("remote.disconnect")}
								</button>
							</Show>
							<button data-testid={`remote-edit-${remote.id}`} disabled={busy() || (remote.status !== "disconnected" && remote.status !== "error" && remote.status !== "awaiting-trust")} class="border border-border px-2 py-1 text-[11px]" onClick={() => setDraft({ id: remote.id, name: remote.name, host: remote.host, user: remote.user ?? "", port: remote.port ? String(remote.port) : "", identityFile: remote.identityFile ?? "", autoConnect: remote.autoConnect })}>
								{i18n.t("remote.edit")}
							</button>
							<button data-testid={`remote-delete-${remote.id}`} disabled={busy()} class="border border-border px-2 py-1 text-[11px] text-danger" onClick={() => void run(() => remoteRequest(`/api/remotes/${remote.id}`, {}, "DELETE"))}>
								{i18n.t("remote.delete")}
							</button>
						</div>
						<Show when={remote.status === "awaiting-trust"}>
							<p class="px-2 pb-2 text-[11px] text-muted" data-testid={`remote-trust-pending-${remote.id}`}>{i18n.t("remote.trustPending")}</p>
						</Show>
						<Show when={remote.error && remote.status !== "awaiting-trust"}>
							<p class="px-2 pb-2 text-[11px] text-danger">{remote.error}</p>
						</Show>
						<Show when={openId() === remote.id}>
							<div class="border-t border-border p-2">
								<div class="flex flex-wrap gap-2 py-2">
									<button data-testid={`remote-install-${remote.id}`} disabled={busy()} class="border border-border px-2 py-1 text-[11px]" onClick={() => setConfirmInstall(remote.id)}>
										{i18n.t("remote.install")}
									</button>
									<button data-testid={`remote-stop-${remote.id}`} disabled={busy() || remote.status !== "connected"} class="border border-border px-2 py-1 text-[11px]" onClick={() => setConfirmStop(remote.id)}>
										{i18n.t("remote.stop")}
									</button>
								</div>
								<Show when={confirmInstall() === remote.id}>
									<div class="settings-discard" data-testid="remote-install-confirm">
										<span>{i18n.t("remote.installConfirm")}</span>
										<button onClick={() => setConfirmInstall(undefined)}>{i18n.t("remote.cancel")}</button>
										<button
											data-testid="remote-install-yes"
											onClick={() => {
												setConfirmInstall(undefined);
												connectAction(remote.id, "install");
											}}
										>
											{i18n.t("remote.install")}
										</button>
									</div>
								</Show>
								<Show when={confirmStop() === remote.id}>
									<div class="settings-discard" data-testid="remote-stop-confirm">
										<span>{i18n.t("remote.stopConfirm")}</span>
										<button onClick={() => setConfirmStop(undefined)}>{i18n.t("remote.cancel")}</button>
										<button
											data-testid="remote-stop-yes"
											onClick={() => {
												setConfirmStop(undefined);
												void run(() => remoteRequest(`/api/remotes/${remote.id}/stop`, {}));
											}}
										>
											{i18n.t("remote.stop")}
										</button>
									</div>
								</Show>
								<div class="settings-section-label">{i18n.t("remote.projects")}</div>
								<For each={remote.projects}>
									{(project) => (
										<div class="flex items-center gap-2 py-1">
											<span class="min-w-0 flex-1 truncate font-mono text-[11px]">{project}</span>
											<button class="border border-border px-1 text-[10px]" onClick={() => void run(() => remoteRequest(`/api/remotes/${remote.id}/projects`, { path: project }, "DELETE"))}>
												{i18n.t("remote.remove")}
											</button>
										</div>
									)}
								</For>
								<Show when={remote.status === "connected"}>
									<RemoteDirectoryPicker remoteId={remote.id} path={projectPath() || "~"} onPath={setProjectPath} />
									<button
										data-testid={`remote-add-project-${remote.id}`}
										class="mt-1 border border-border px-2 py-1 text-[11px]"
										disabled={!projectPath().startsWith("/")}
										onClick={() => void run(() => remoteRequest(`/api/remotes/${remote.id}/projects`, { path: projectPath() }))}
									>
										{i18n.t("remote.addProject")}
									</button>
								</Show>
								<div class="settings-section-label">{i18n.t("remote.forwards")}</div>
								<For each={remote.ports}>
									{(port) => (
										<div class="flex items-center gap-2 py-1 font-mono text-[11px]">
											<span>
												{port.remotePort} → 127.0.0.1:{port.localPort || "…"}
											</span>
											<Show when={port.active}>
												<a class="text-accent" href={`http://127.0.0.1:${port.localPort}`} target="_blank" rel="noreferrer">
													{i18n.t("remote.openPreview")}
												</a>
											</Show>
											<button class="border border-border px-1 text-[10px]" onClick={() => void run(() => remoteRequest(`/api/remotes/${remote.id}/forwards`, { id: port.id }, "DELETE"))}>
												{i18n.t("remote.remove")}
											</button>
										</div>
									)}
								</For>
								<div class="settings-inline py-1">
									<input data-testid={`remote-forward-remote-${remote.id}`} placeholder={i18n.t("remote.remotePort")} value={forwardPort()} onInput={(event) => setForwardPort(event.currentTarget.value)} />
									<input data-testid={`remote-forward-local-${remote.id}`} placeholder={i18n.t("remote.localPort")} value={forwardLocal()} onInput={(event) => setForwardLocal(event.currentTarget.value)} />
									<button
										data-testid={`remote-forward-add-${remote.id}`}
										class="border border-border px-2 py-1 text-[11px]"
										disabled={busy() || remote.status !== "connected"}
										onClick={() =>
											void run(() =>
												remoteRequest(`/api/remotes/${remote.id}/forwards`, {
													remotePort: Number(forwardPort()),
													localPort: forwardLocal() ? Number(forwardLocal()) : 0,
												}),
											).then(() => {
												setForwardPort("");
												setForwardLocal("");
											})
										}
									>
										{i18n.t("remote.forward")}
									</button>
								</div>
								<Show when={remote.backend}>
									{(backend) => (
										<p class="font-mono text-[11px] text-muted" data-testid={`remote-backend-${remote.id}`}>
											{i18n.t("remote.backendLine", { version: backend().version, pid: String(backend().pid) })}
											{" · "}
											{backend().reused ? i18n.t("remote.reused") : i18n.t("remote.owns")}
											{backend().installed === undefined ? "" : ` · ${i18n.t("remote.installedBuild", { build: backend().installed!.slice(0, 8) })}`}
										</p>
									)}
								</Show>
								<Show when={remote.logs.length > 0}>
									<pre class="max-h-32 overflow-auto bg-overlay p-2 font-mono text-[10px] text-muted" data-testid={`remote-logs-${remote.id}`}>
										{remote.logs.join("\n")}
									</pre>
								</Show>
								<Show when={remote.status === "connected"}>
									<div class="settings-section-label">{i18n.t("remote.modelsOn", { name: remote.name, host: remote.host })}</div>
									<p class="settings-hint">{i18n.t("remote.modelsScope")}</p>
										<ProvidersSettings apiBase={`/api/remote/${remote.id}`} onDirtyChange={setProvidersDirty} onBusyChange={setBusy} />
								</Show>
							</div>
						</Show>
					</div>
				)}
			</For>
		</div>
	);
}

function RemoteDraftDialog(props: {
	initial: Draft;
	hosts: string[];
	busy: boolean;
	error: string;
	onCancel(): void;
	onSave(draft: Draft): void;
}) {
	const i18n = useAppI18n();
	const [draft, setDraft] = createSignal(props.initial);
	let dialog!: HTMLDialogElement;
	onMount(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		try {
			dialog.showModal();
		} catch {
			dialog.setAttribute("open", "");
		}
		onCleanup(() => {
			try {
				if (dialog.open) dialog.close();
			} catch {
				/* jsdom */
			}
			if (previous?.isConnected) previous.focus();
		});
	});
	const requestClose = () => {
		if (!props.busy) props.onCancel();
	};
	const update = (patch: Partial<Draft>) => setDraft({ ...draft(), ...patch });
	return (
		<dialog
			ref={dialog}
			class="settings-dialog settings-subdialog"
			data-testid="remote-draft"
			aria-labelledby="remote-draft-title"
			onCancel={(event) => {
				event.preventDefault();
				requestClose();
			}}
			onKeyDown={(event) => {
				event.stopPropagation();
				if (event.key !== "Tab") return;
				const elements = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)")].filter((element) => element.getClientRects().length > 0);
				const first = elements[0];
				const last = elements.at(-1);
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault();
					last?.focus();
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault();
					first?.focus();
				}
			}}
			onClick={(event) => {
				if (event.target !== dialog) return;
				const rect = dialog.getBoundingClientRect();
				if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) requestClose();
			}}
		>
			<header class="settings-header">
				<div>
					<span class="mono">SSH</span>
					<h1 id="remote-draft-title">{i18n.t(draft().id ? "remote.editTitle" : "remote.addTitle")}</h1>
				</div>
				<button data-testid="remote-draft-close" disabled={props.busy} aria-label={i18n.t("settings.close")} onClick={requestClose}>
					✕
				</button>
			</header>
			<div class="settings-content">
				<div class="settings-row"><div class="settings-row-label"><div>{i18n.t("remote.name")}</div></div><div class="settings-control">
					<input data-testid="remote-name" value={draft().name} onInput={(event) => update({ name: event.currentTarget.value })} />
				</div></div>
				<div class="settings-row"><div class="settings-row-label"><div>{i18n.t("remote.host")}</div><p>{i18n.t("remote.hostNote")}</p></div><div class="settings-control">
					<div class="settings-inline">
						<input data-testid="remote-host" list="remote-hosts" value={draft().host} onInput={(event) => update({ host: event.currentTarget.value })} />
						<datalist id="remote-hosts">
							<For each={props.hosts}>{(host) => <option value={host} />}</For>
						</datalist>
					</div>
				</div></div>
				<div class="settings-row"><div class="settings-row-label"><div>{i18n.t("remote.user")}</div></div><div class="settings-control">
					<input data-testid="remote-user" value={draft().user} onInput={(event) => update({ user: event.currentTarget.value })} />
				</div></div>
				<div class="settings-row"><div class="settings-row-label"><div>{i18n.t("remote.port")}</div></div><div class="settings-control">
					<input data-testid="remote-port" inputMode="numeric" value={draft().port} onInput={(event) => update({ port: event.currentTarget.value })} />
				</div></div>
				<div class="settings-row"><div class="settings-row-label"><div>{i18n.t("remote.identity")}</div><p>{i18n.t("remote.identityNote")}</p></div><div class="settings-control">
					<input data-testid="remote-identity" placeholder="~/.ssh/id_ed25519" value={draft().identityFile} onInput={(event) => update({ identityFile: event.currentTarget.value })} />
				</div></div>
				<div class="settings-row"><div class="settings-row-label"><div>{i18n.t("remote.autoConnect")}</div></div><div class="settings-control">
					<input data-testid="remote-auto" type="checkbox" checked={draft().autoConnect} onChange={(event) => update({ autoConnect: event.currentTarget.checked })} />
				</div></div>
				<Show when={props.error}>
					<p class="settings-hint" data-testid="remote-draft-error" role="alert">{props.error}</p>
				</Show>
				<div class="settings-save">
					<button data-testid="remote-cancel" disabled={props.busy} onClick={requestClose}>
						{i18n.t("remote.cancel")}
					</button>
					<button data-testid="remote-save" class="settings-primary" disabled={!draft().name.trim() || !draft().host.trim() || props.busy} onClick={() => props.onSave(draft())}>
						{i18n.t("remote.save")}
					</button>
				</div>
			</div>
		</dialog>
	);
}

function HostKeyDialog(props: { value: RemoteHostKey; busy: boolean; error: string; onCancel(): void; onTrust(): void }) {
	const i18n = useAppI18n();
	let dialog!: HTMLDialogElement;
	onMount(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		try { dialog.showModal(); } catch { dialog.setAttribute("open", ""); }
		dialog.querySelector<HTMLButtonElement>("button")?.focus();
		onCleanup(() => { try { dialog.close(); } catch {} if (previous?.isConnected) previous.focus(); });
	});
	return <dialog ref={dialog} class="settings-dialog settings-subdialog" data-testid="remote-host-key" aria-labelledby="host-key-title"
		onCancel={(event) => { event.preventDefault(); props.onCancel(); }} onKeyDown={(event) => event.stopPropagation()}>
		<header class="settings-header"><h1 id="host-key-title">{i18n.t("remote.hostKeyTitle")}</h1></header>
		<div class="min-h-0 overflow-y-auto p-4 space-y-3">
			<p>{i18n.t("remote.hostKeyNote")}</p>
			<p class="font-mono break-all">{props.value.host} · {props.value.algorithm}</p>
			<p class="font-mono break-all select-text" data-testid="remote-host-fingerprint">{props.value.fingerprint}</p>
			<details><summary>{i18n.t("remote.hostKeyDetails")}</summary><pre class="whitespace-pre-wrap break-all text-xs">{props.value.prompt}</pre></details>
			<Show when={props.error}><p role="alert" class="text-danger">{props.error}</p></Show>
			<div class="flex justify-end gap-3">
				<button data-testid="remote-host-cancel" disabled={props.busy} onClick={props.onCancel}>{i18n.t("remote.cancel")}</button>
				<button data-testid="remote-host-trust" disabled={props.busy} onClick={props.onTrust}>{i18n.t("remote.hostKeyTrust")}</button>
			</div>
		</div>
	</dialog>;
}
