import { useEffect, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { etaStore } from "../../lib/eta-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.tsx";

interface ModelInfo {
	models: { id: string; label: string }[];
	current: string;
}

export function ModelPicker({ session }: { session: string }) {
	const store = etaStore();
	const [info, setInfo] = useState<ModelInfo | undefined>(undefined);

	useEffect(() => {
		setInfo(undefined);
		void fetch(`/api/models?session=${encodeURIComponent(session)}`)
			.then((response) => (response.ok ? (response.json() as Promise<ModelInfo>) : undefined))
			.then((body) => setInfo(body))
			.catch(() => undefined);
	}, [session]);

	if (info === undefined) return <span className="mono text-[10px] text-muted">{info === undefined ? "…" : ""}</span>;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button data-testid="model-picker" variant="outline" size="sm" className="mono gap-1 text-[10px] lowercase">
					{info.current}
					<ChevronDownIcon className="size-3" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" data-testid="model-menu">
				{info.models.map((model) => (
					<DropdownMenuItem
						key={model.id}
						data-testid={`model-${model.id}`}
						disabled={model.id === info.current}
						onClick={() => {
							setInfo({ ...info, current: model.id });
							store.send({ op: "modelSet", session, modelId: model.id });
						}}
					>
						{model.label}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
