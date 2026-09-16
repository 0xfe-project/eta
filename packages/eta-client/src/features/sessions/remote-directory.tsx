import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { useAppI18n } from "../../i18n.ts";
import { apiFetch } from "../../lib/host.ts";
import { remoteApiPath, type RemoteDirectory } from "../../lib/remotes.ts";

/**
 * Remote folder browser. Every keystroke, every host switch and every reconnect asks
 * for a listing, and those requests do not come back in the order they went out — so
 * only the newest one may write. A late failure used to land on top of a newer success
 * and paint an error under a directory that listed fine, which read as "this folder is
 * broken" when the folder was simply empty.
 */
export function RemoteDirectoryPicker(props: {
	remoteId?: string;
	path: string;
	/** false only when the host is known to be down; undefined means "ask anyway". */
	connected?: boolean;
	onPath(path: string): void;
}) {
	const i18n = useAppI18n();
	const [listing, setListing] = createSignal<RemoteDirectory>();
	const [failed, setFailed] = createSignal(false);
	/** Bumped per request; a response that is not the current one is dropped. */
	let seq = 0;
	const load = async (path: string) => {
		const attempt = ++seq;
		setFailed(false);
		try {
			const query = `/api/directories?path=${encodeURIComponent(path || "~")}`;
			const response = await apiFetch(remoteApiPath(query, props.remoteId));
			if (attempt !== seq) return;
			if (!response.ok) throw new Error();
			const body = (await response.json()) as RemoteDirectory;
			if (attempt !== seq) return;
			if (!body || !Array.isArray(body.directories)) throw new Error();
			setListing(body);
			if (body.path !== props.path) props.onPath(body.path);
		} catch {
			if (attempt === seq) setFailed(true);
		}
	};
	onCleanup(() => {
		seq += 1;
	});
	let lastRemote: string | undefined;
	createEffect(() => {
		const remote = props.remoteId;
		if (remote !== lastRemote) {
			// A different machine means a different filesystem: whatever is on screen
			// belongs to the old one until this machine answers.
			lastRemote = remote;
			setListing(undefined);
		}
		const connected = props.connected;
		const target = props.path || "~";
		if (connected === false) {
			// Nothing is asked while the host is down, and whatever was in flight is
			// invalid: the effect runs again the moment it reconnects.
			seq += 1;
			setFailed(false);
			return;
		}
		void load(target);
	});
	return (
		<div class="flex flex-col gap-1" data-testid="remote-directory">
			<div class="flex items-center gap-1">
				<input
					data-testid="remote-directory-path"
					value={props.path}
					onChange={(event) => void load(event.currentTarget.value)}
					class="min-w-0 flex-1 border border-border bg-background px-2 py-1 font-mono text-xs"
				/>
				<Show when={listing() && listing()!.path !== listing()!.parent}>
					<button
						data-testid="remote-directory-up"
						class="border border-border px-2 py-1 text-xs text-muted hover:border-border-strong"
						onClick={() => void load(listing()!.parent)}
					>
						{i18n.t("remote.up")}
					</button>
				</Show>
			</div>
			<Show when={props.connected === false}>
				<p class="text-[11px] text-muted" data-testid="remote-directory-offline">
					{i18n.t("remote.directoryOffline")}
				</p>
			</Show>
			<Show when={props.connected !== false && failed()}>
				<p class="text-[11px] text-danger" data-testid="remote-directory-error">
					{i18n.t("remote.directoryError")}
				</p>
			</Show>
			{/* The empty label belongs to a listing that arrived, never to a request that
			    did not: "no subdirectories" beside a failure is what made an empty folder
			    look like the cause of the error. */}
			<Show when={props.connected !== false && !failed()}>
				<div class="max-h-40 overflow-y-auto border border-border">
					<Show when={listing()} fallback={<p class="p-2 text-[11px] text-muted">…</p>}>
						{(current) => (
							<For each={current().directories} fallback={<p class="p-2 text-[11px] text-muted" data-testid="remote-directory-empty">{i18n.t("remote.emptyDirectory")}</p>}>
								{(entry) => (
									<button
										data-testid={`remote-dir-${entry.name}`}
										class="block w-full truncate border-b border-border px-2 py-1 text-left font-mono text-[11px] hover:bg-overlay"
										onClick={() => void load(entry.path)}
									>
										{entry.name}
									</button>
								)}
							</For>
						)}
					</Show>
				</div>
			</Show>
		</div>
	);
}
