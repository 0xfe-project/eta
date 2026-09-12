import { For, Show, createSignal, on, createEffect } from "solid-js";
import { etaStore, useEta } from "../../lib/eta-store.ts";
import { useAppI18n } from "../../i18n.ts";
import { Button } from "../../components/ui/button.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.tsx";
import { apiFetch } from "../../lib/host.ts";

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
export function ModelPicker(props: { session?: string; onPick?: (modelId: string) => void }) {
	const i18n = useAppI18n();
	const store = etaStore();
	const state = useEta();
	const [info, setInfo] = createSignal<ModelInfo | undefined>(undefined);
	/** Only for a session that does not exist yet: there, the pick is the truth. */
	const [planned, setPlanned] = createSignal<string | undefined>(undefined);

	createEffect(
		on(
			() => props.session,
			(session) => {
				setInfo(undefined);
				setPlanned(undefined);
				void apiFetch(session === undefined ? "/api/models" : `/api/models?session=${encodeURIComponent(session)}`)
					.then((response) => (response.ok ? (response.json() as Promise<ModelInfo>) : undefined))
					.then((body) => setInfo(body))
					.catch(() => undefined);
			},
		),
	);

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
				<DropdownMenu>
					<DropdownMenuTrigger>
						<Button data-testid="model-picker" variant="outline" size="sm" class="mono gap-1 text-[10px] lowercase">
							{shown() === undefined ? "…" : labelOf(shown()!)}
							<Show when={pending() !== undefined}>
								<span data-testid="model-pending" class="text-warning" title={`${i18n.t("panel.modelPending")}: ${pending()}`}>
									⚠
								</span>
							</Show>
							<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-3">
								<path d="m6 9 6 6 6-6" />
							</svg>
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" data-testid="model-menu">
						<For each={info()?.models ?? []}>
							{(model) => (
								<DropdownMenuItem
									data-testid={`model-${model.id}`}
									disabled={model.id === shown()}
									onClick={() => {
										if (props.session === undefined) setPlanned(model.id);
										else store.send({ op: "modelSet", session: props.session, modelId: model.id });
										props.onPick?.(model.id);
									}}
								>
									{model.label}
									<Show when={model.id === live()}>
										<span class="mono ml-1 text-[9px] text-faint">{i18n.t("panel.model")}</span>
									</Show>
								</DropdownMenuItem>
							)}
						</For>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</Show>
	);
}
