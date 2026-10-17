import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * The two chips a single-agent conversation carries: which model, and how hard it thinks.
 *
 * They read the *session*, not the settings: what a chip says is what the next turn will run on.
 * When the two disagree — you asked for one model and a turn is still finishing on another — the
 * chip shows the one that is actually running and marks the other `pending`. A chip that flips the
 * moment it is clicked reports a decision, not a fact, and a refused change would read as
 * "switched" forever.
 *
 * In a group these are not shown: several agents can be on different models, so there is no single
 * answer to put in one chip. There the composer's member picker takes their place.
 */

interface Live {
  model: string | null;
  thinking_level: string;
}

const sessionKey = (id: string | undefined) => ["session-model", id] as const;

function useSessionModel(sessionId: string | undefined) {
  return useQuery({
    queryKey: sessionKey(sessionId),
    enabled: sessionId !== undefined,
    staleTime: 5_000,
    queryFn: async (): Promise<Live | null> => {
      if (sessionId === undefined) return null;
      const response = await fetch(
        `/sessions/${encodeURIComponent(sessionId)}/model`,
      );
      return response.ok ? ((await response.json()) as Live) : null;
    },
  });
}

function usePatchModel(sessionId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (patch: { model?: string; thinking_level?: string }) => {
      if (sessionId === undefined) return null;
      const response = await fetch(
        `/sessions/${encodeURIComponent(sessionId)}/model`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      if (!response.ok) throw new Error("model change refused");
      return (await response.json()) as Live;
    },
    onSuccess: (live) => {
      if (live !== null) client.setQueryData(sessionKey(sessionId), live);
    },
  });
}

const CHIP =
  "inline-flex h-7 min-w-0 items-center gap-1 border border-border px-2 font-mono text-[11px] text-muted-foreground outline-none hover:border-border-strong focus-visible:ring-1 focus-visible:ring-ring";

async function fetchModels() {
  const response = await fetch("/api/llm/v1/models");
  return response.ok
    ? ((await response.json()) as {
        id: string;
        connector: string;
        display_name: string;
        available: boolean;
      }[])
    : [];
}

export function ModelChip({ sessionId }: { sessionId: string | undefined }) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const { data: live } = useSessionModel(sessionId);
  const patch = usePatchModel(sessionId);
  const { data: models } = useQuery({
    queryKey: ["llm", "models"],
    staleTime: 60_000,
    queryFn: fetchModels,
  });
  // Which service each group is: the connection list knows the labels (a provider's own
  // name first, the preset's name otherwise), so the menu can say "公司账号" instead of
  // "openai-compatible".
  const { data: connections } = useQuery({
    queryKey: ["llm", "connections"],
    staleTime: 60_000,
    queryFn: async () => {
      const response = await fetch("/api/llm/v1/connections");
      return response.ok
        ? ((await response.json()) as {
            id: string;
            connector: string;
            label: string;
          }[])
        : [];
    },
  });
  // eta-old groups models under their provider (one optgroup per provider); a flat list
  // answers "which model" but never "from where", and the same model name can come from
  // two places at once.
  const groups: {
    connector: string;
    label: string;
    models: ReturnType<typeof fetchModels> extends Promise<infer T> ? T : never;
  }[] = [];
  for (const model of models ?? []) {
    let group = groups.find((entry) => entry.connector === model.connector);
    if (!group) {
      group = {
        connector: model.connector,
        label:
          (connections ?? []).find(
            (connection) => connection.connector === model.connector,
          )?.label ?? model.connector,
        models: [],
      };
      groups.push(group);
    }
    group.models.push(model);
  }
  if (sessionId === undefined) return null;
  const current = live?.model ?? "";
  const pending = patch.isPending ? patch.variables?.model : undefined;
  const shown = current.length > 0 ? current : "—";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={CHIP}
          title={translateText("chat:composer.modelHint")}
        >
          <span className="max-w-40 truncate">{shown}</span>
          {pending !== undefined && pending !== current ? (
            <span className="text-state-warning">→ {pending}</span>
          ) : null}
          <CaretDownIcon aria-hidden="true" className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        <DropdownMenuLabel>
          {translateText("chat:composer.model")}
        </DropdownMenuLabel>
        {groups.map((group) => (
          <DropdownMenuGroup key={group.connector}>
            <DropdownMenuLabel className="text-[10px] tracking-[0.12em] text-faint uppercase">
              {group.label}
            </DropdownMenuLabel>
            {group.models.map((model) => (
              <DropdownMenuItem
                key={model.id}
                disabled={!model.available}
                onSelect={() => patch.mutate({ model: model.id })}
              >
                <span className="min-w-0 flex-1 truncate">
                  {model.display_name}
                </span>
                <span className="font-mono text-[10px] text-faint">
                  {model.id}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const LEVELS = ["off", "minimal", "low", "medium", "high"] as const;

export function ThinkingChip({ sessionId }: { sessionId: string | undefined }) {
  const { t: translateText } = useTranslation(["chat"] as const);
  const { data: live } = useSessionModel(sessionId);
  const patch = usePatchModel(sessionId);
  if (sessionId === undefined) return null;
  const level = live?.thinking_level ?? "off";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={CHIP}
          title={translateText("chat:composer.thinkingHint")}
        >
          <span className="truncate">{`think:${level}`}</span>
          <CaretDownIcon aria-hidden="true" className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>
          {translateText("chat:composer.thinking")}
        </DropdownMenuLabel>
        {LEVELS.map((choice) => (
          <DropdownMenuItem
            key={choice}
            onSelect={() => patch.mutate({ thinking_level: choice })}
          >
            <span
              className={cn(
                "min-w-0 flex-1 font-mono",
                choice === level && "text-foreground",
              )}
            >
              {choice}
            </span>
            {choice === level ? <span aria-hidden="true">✓</span> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
