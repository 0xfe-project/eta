import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { THINKING_LEVELS } from "@/lib/thinking";
import { cn } from "@/lib/utils";
import { modelGroups, useModels } from "@/queries/providers";
import { useSession, useSessionActions } from "@/queries/sessions";

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

const onError = (error: Error) => toast.error(error.message);

const CHIP =
  "inline-flex h-7 min-w-0 items-center gap-1 border border-border px-2 font-mono text-[11px] text-muted-foreground outline-none hover:border-border-strong focus-visible:ring-1 focus-visible:ring-ring";

export function ModelChip({ sessionId }: { sessionId: string | undefined }) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const live = useSession(sessionId)?.model;
  const { modelSet } = useSessionActions();
  // The menu lists the configured providers' models, one group per provider.
  const { data: models } = useModels();
  const groups = modelGroups(models ?? []);
  if (sessionId === undefined) return null;
  const current = live?.id ?? "";
  const pending = modelSet.isPending ? modelSet.variables?.model : undefined;
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
          <DropdownMenuGroup key={group.provider}>
            <DropdownMenuLabel className="text-[10px] tracking-[0.12em] text-faint uppercase">
              {group.label}
            </DropdownMenuLabel>
            {group.models.map((model) => (
              <DropdownMenuItem
                key={model.id}
                disabled={!model.available}
                onSelect={() =>
                  modelSet.mutate(
                    { session: sessionId, model: model.id },
                    { onError },
                  )
                }
              >
                <span className="min-w-0 flex-1 truncate">{model.name}</span>
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

export function ThinkingChip({ sessionId }: { sessionId: string | undefined }) {
  const { t: translateText } = useTranslation(["chat"] as const);
  const live = useSession(sessionId)?.model;
  const { thinkingLevel } = useSessionActions();
  if (sessionId === undefined) return null;
  const level = live?.thinkingLevel ?? "off";
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
        {THINKING_LEVELS.map((choice) => (
          <DropdownMenuItem
            key={choice}
            onSelect={() =>
              thinkingLevel.mutate(
                { session: sessionId, level: choice },
                { onError },
              )
            }
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
