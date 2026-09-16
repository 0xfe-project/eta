import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { useAppI18n } from "../../i18n.ts";
import { nativeAvailable } from "../../lib/host.ts";
import { pickFolder } from "../../lib/native.ts";
import { isRemoteViewList, remoteRequest, type RemoteView } from "../../lib/remotes.ts";
import { openSettings } from "../../lib/settings.ts";
import { RemoteDirectoryPicker } from "./remote-directory.tsx";

export function WorkspaceTarget(props: {
	remoteId: string | undefined;
	cwd: string;
	onRemoteId(id: string | undefined): void;
	onCwd(cwd: string): void;
	browse?: boolean;
}) {
	const i18n = useAppI18n();
	const [remotes, setRemotes] = createSignal<RemoteView[]>([]);
	const selected = () => remotes().find((remote) => remote.id === props.remoteId);
	const load = () => {
		void remoteRequest<unknown>("/api/remotes")
			.then((body) => setRemotes(isRemoteViewList(body) ? body : []))
			.catch(() => setRemotes([]));
	};
	onMount(() => {
		load();
		window.addEventListener("eta:remotes", load);
		onCleanup(() => window.removeEventListener("eta:remotes", load));
	});
	createEffect(() => {
		const remote = selected();
		if (remote && !props.cwd && remote.projects[0]) props.onCwd(remote.projects[0]!);
	});
	const browse = async () => {
		if (props.remoteId) return;
		const starting = props.cwd.trim();
		const picked = await pickFolder(starting.length > 0 ? starting : undefined);
		if (typeof picked === "string" && picked.length > 0) props.onCwd(picked);
	};
	return (
		<div class="flex flex-col gap-2" data-testid="workspace-target">
			<div class="flex items-center gap-2">
				<select
					data-testid="workspace-host"
					aria-label={i18n.t("remote.host")}
					value={props.remoteId ?? ""}
					onChange={(event) => {
						const id = event.currentTarget.value || undefined;
						props.onRemoteId(id);
						const remote = remotes().find((item) => item.id === id);
						props.onCwd(remote?.projects[0] ?? "");
					}}
					class="min-w-0 flex-1 border-2 border-border bg-background px-3 py-2 text-sm"
				>
					<option value="" selected={!props.remoteId}>{i18n.t("remote.thisComputer")}</option>
					<For each={remotes()}>
						{(remote) => (
							<option value={remote.id} selected={props.remoteId === remote.id} disabled={remote.status !== "connected"}>
								{remote.name} · {remote.host}
								{remote.status === "connected" ? "" : ` (${i18n.t(`remote.status.${remote.status}` as "remote.status.disconnected")})`}
							</option>
						)}
					</For>
				</select>
				<button data-testid="workspace-remotes" class="shrink-0 border border-border px-2 py-2 text-xs text-muted hover:border-border-strong" onClick={() => openSettings()}>
					{i18n.t("remote.manage")}
				</button>
			</div>
			<Show
				when={props.remoteId}
				fallback={
					<div class="flex items-center gap-2">
						<input
							data-testid="cwd-input"
							value={props.cwd}
							placeholder={i18n.t("new.cwd")}
							onInput={(event) => props.onCwd(event.currentTarget.value)}
							class="min-w-0 flex-1 border-2 border-border bg-background px-3 py-2 text-sm outline-none focus:border-border-strong"
						/>
						<Show when={props.browse !== false && nativeAvailable()}>
							<button
								data-testid="cwd-browse"
								title={i18n.t("new.browse")}
								onClick={() => void browse()}
								class="shrink-0 whitespace-nowrap border-2 border-border bg-background px-3 py-2 text-sm text-muted hover:border-border-strong"
							>
								{i18n.t("new.browse")}
							</button>
						</Show>
					</div>
				}
			>
				<Show when={selected()?.projects.length}>
					<div class="flex flex-wrap gap-1">
						<For each={selected()?.projects ?? []}>
							{(project) => (
								<button
									data-testid={`remote-project-${project}`}
									class={`border px-2 py-1 font-mono text-[11px] ${props.cwd === project ? "border-primary text-primary" : "border-border text-muted"}`}
									onClick={() => props.onCwd(project)}
								>
									{project}
								</button>
							)}
						</For>
					</div>
				</Show>
				<RemoteDirectoryPicker
					remoteId={props.remoteId}
					path={props.cwd || "~"}
					connected={selected() === undefined ? undefined : selected()!.status === "connected"}
					onPath={props.onCwd}
				/>
			</Show>
		</div>
	);
}
