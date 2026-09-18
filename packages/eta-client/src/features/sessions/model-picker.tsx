import { For, Show, createSignal, on, createEffect, onMount, onCleanup } from "solid-js";
import { etaStore, useEta } from "../../lib/eta-store.ts";
import { useAppI18n } from "../../i18n.ts";
import { Button } from "../../components/ui/button.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuChevron } from "../../components/ui/dropdown-menu.tsx";
import { apiFetch } from "../../lib/host.ts";
import { remoteApiPath } from "../../lib/remotes.ts";
import { openSettings } from "../../lib/settings.ts";

interface ModelInfo {
	models: { id: string; label: string }[];
	current: string;
}

/**
 * The model chip in the composer.
 *
 * Two sources meet here and they are not the same claim. `/api/models` answers with the
 * catalog and with what the host *means* to run (the id in meta.json, else the configured
 * default); the session view carries the model the harness is actually driving. For an open
 * session the view wins, because a chip that flips the moment it is clicked reports a
 * decision rather than a fact — a refused swap (an id the registry does not have, a faux
 * session with nothing to swap) would then read as "switched" forever. The desired id stays
 * visible as pending instead, and the chip changes when the harness does.
 */
export function ModelPicker(props: { session?: string; remoteId?: string; onPick?: (modelId: string | undefined) => void }) {
	const i18n = useAppI18n();
	const store = etaStore();
	const state = useEta();
	const [info, setInfo] = createSignal<ModelInfo | undefined>(undefined);
	/** Only for a session that does not exist yet: there, the pick is the truth. */
	const [planned, setPlanned] = createSignal<string | undefined>(undefined);

	let requestVersion = 0;
	const refresh = (reset = false) => {
		const request = ++requestVersion;
		const session = props.session;
		if (reset) { setInfo(undefined); setPlanned(undefined); props.onPick?.(undefined); }
		void apiFetch(session === undefined ? remoteApiPath("/api/models", props.remoteId) : `/api/models?session=${encodeURIComponent(session)}`)
			.then(response => response.ok ? response.json() as Promise<ModelInfo> : undefined)
			.then(body => {
				if (request !== requestVersion || !body || !Array.isArray(body.models)) return;
				setInfo(body);
				if (planned() && !body.models.some(model => model.id === planned())) { setPlanned(undefined); props.onPick?.(undefined); }
			})
			.catch(() => undefined);
	};
	createEffect(on(() => [props.session, props.remoteId], () => refresh(true)));
	onMount(() => {
		const changed = () => refresh();
		window.addEventListener("eta:models", changed);
		onCleanup(() => { requestVersion += 1; window.removeEventListener("eta:models", changed); });
	});

	const live = () => (props.session === undefined ? undefined : state.views[props.session]?.model);
	const shown = () => live() ?? planned() ?? info()?.current;
	/** Asked for but not running: the swap was refused, or it is still on its way. */
	const pending = () => {
		const running = live();
		const wanted = info()?.current;
		return running !== undefined && wanted !== undefined && running !== wanted ? wanted : undefined;
	};
	const labelOf = (modelId: string) => info()?.models.find((model) => model.id === modelId)?.label ?? modelId;

	return (
		<Show when={info() !== undefined || live() !== undefined} fallback={<span class="mono text-[10px] text-muted">…</span>}>
			{(_ready) => (
				<Show when={(info()?.models.length ?? 0) > 0} fallback={<Button type="button" class="composer-control" onClick={openSettings}>{i18n.t("providers.configureModels")}</Button>}>
				<DropdownMenu>
					<DropdownMenuTrigger data-testid="model-picker" class="composer-control composer-model-control" title={shown() ? labelOf(shown()!) : undefined}>
							<span class="composer-control-label">{shown() === undefined ? "…" : labelOf(shown()!)}</span>
							<Show when={pending() !== undefined}>
								<span data-testid="model-pending" class="text-warning" title={`${i18n.t("panel.modelPending")}: ${pending()}`}>
									⚠
								</span>
							</Show>
							<DropdownMenuChevron />
					</DropdownMenuTrigger>
					<DropdownMenuContent side="top" align="start" data-testid="model-menu">
						<For each={info()?.models ?? []}>
							{(model) => (
								<DropdownMenuItem
									data-testid={`model-${model.id}`}
									role="menuitemradio" aria-checked={model.id === shown()}
									disabled={model.id === shown() || (props.session !== undefined && state.sessions.some(session => session.name === props.session && session.badges.includes("running")))}
									onClick={() => {
										if (props.session === undefined) setPlanned(model.id);
										else { setInfo(previous => previous ? { ...previous, current: model.id } : previous); store.send({ op: "modelSet", session: props.session, modelId: model.id }); }
										props.onPick?.(model.id);
									}}
								>
									<span class="min-w-0 [overflow-wrap:anywhere]">{model.label}</span>
									<Show when={model.id === live()}>
										<span class="mono ml-1 text-[9px] text-faint">{i18n.t("panel.model")}</span>
									</Show>
								</DropdownMenuItem>
							)}
						</For>
					</DropdownMenuContent>
				</DropdownMenu>
				</Show>
			)}
		</Show>
	);
}
