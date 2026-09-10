import { For, Show, createSignal, on, createEffect } from "solid-js";
import { etaStore } from "../../lib/eta-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.tsx";

interface ModelInfo {
	models: { id: string; label: string }[];
	current: string;
}

export function ModelPicker(props: { session?: string; onPick?: (modelId: string) => void }) {
	const store = etaStore();
	const [info, setInfo] = createSignal<ModelInfo | undefined>(undefined);

	createEffect(
		on(
			() => props.session,
			(session) => {
				setInfo(undefined);
				void fetch(session === undefined ? "/api/models" : `/api/models?session=${encodeURIComponent(session)}`)
					.then((response) => (response.ok ? (response.json() as Promise<ModelInfo>) : undefined))
					.then((body) => setInfo(body))
					.catch(() => undefined);
			},
		),
	);

	return (
		<Show when={info()} fallback={<span class="mono text-[10px] text-muted">…</span>}>
			{(current) => (
				<DropdownMenu>
					<DropdownMenuTrigger>
						<Button data-testid="model-picker" variant="outline" size="sm" class="mono gap-1 text-[10px] lowercase">
							{current().current}
							<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-3">
								<path d="m6 9 6 6 6-6" />
							</svg>
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" data-testid="model-menu">
						<For each={current().models}>
							{(model) => (
								<DropdownMenuItem
									data-testid={`model-${model.id}`}
									disabled={model.id === current().current}
									onClick={() => {
										setInfo({ ...current(), current: model.id });
										if (props.session !== undefined) store.send({ op: "modelSet", session: props.session, modelId: model.id });
										props.onPick?.(model.id);
									}}
								>
									{model.label}
								</DropdownMenuItem>
							)}
						</For>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</Show>
	);
}
