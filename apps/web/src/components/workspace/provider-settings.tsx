import type { Model } from "@/queries/providers";
import type { Source } from "@/queries/sources";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  providerErrorMessage,
  useModels,
  useSetDefaultModel,
} from "@/queries/providers";
import { useSources } from "@/queries/sources";
import { AddSourceDialog } from "./add-source-dialog";
import { Select, SelectOption } from "./select-field";
import { SourceDetail } from "./source-detail";
import { QuotaMeter, SourceLogo, StatusLabel } from "./source-parts";
import { viaText } from "./source-text";

/**
 * The model new agents start on, chosen from every model a working source offers. A source that
 * needs a key or a sign-in offers none until it has one.
 */
function DefaultModel({ sources }: { sources: readonly Source[] }) {
  const { t: translateText } = useTranslation(["providers"] as const);
  const labelId = useId();
  const { data: models } = useModels();
  const setDefault = useSetDefaultModel();
  const working = new Set(
    sources.flatMap((source) =>
      source.type === "provider" && source.status === "ok"
        ? [source.provider.id]
        : [],
    ),
  );
  const current = models?.find((model) => model.default);
  const offered = (models ?? []).filter(
    (model: Model) =>
      model === current ||
      (model.available &&
        (model.provider === "llm" || working.has(model.provider))),
  );
  return (
    <div className="flex min-w-0 items-center gap-2.5 bg-surface px-3 py-2">
      <span id={labelId} className="shrink-0 text-xs text-muted-foreground">
        {translateText("defaultModel.label")}
      </span>
      {offered.length === 0 ? (
        <span className="text-xs text-faint">
          {translateText("defaultModel.none")}
        </span>
      ) : (
        <Select
          aria-labelledby={labelId}
          className="h-7 min-w-0 flex-1 text-xs"
          value={current?.id ?? ""}
          disabled={setDefault.isPending}
          onValueChange={(value) =>
            setDefault.mutate(value, {
              onError: (error) => toast.error(providerErrorMessage(error)),
            })
          }
        >
          {offered.map((model) => (
            <SelectOption key={model.id} value={model.id}>
              {model.providerName} · {model.name}
            </SelectOption>
          ))}
        </Select>
      )}
    </div>
  );
}

function SourceRow({ source, onOpen }: { source: Source; onOpen: () => void }) {
  const { t: translateText } = useTranslation(["providers"] as const);
  return (
    <li>
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2.5 px-2.5 py-2 text-left duration-[60ms] ease-linear hover:bg-overlay-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        onClick={onOpen}
      >
        <SourceLogo name={source.name} />
        <span className="min-w-0 flex-1 truncate text-sm">
          {source.name}
          <span className="text-xs text-faint">
            {" · "}
            {viaText(source)}
            {source.type === "account" ? ` · ${source.connection.label}` : ""}
          </span>
        </span>
        {source.type === "account" ? <QuotaMeter quota={source.quota} /> : null}
        <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums max-sm:hidden">
          {translateText("list.modelCount", { count: source.models })}
        </span>
        <StatusLabel status={source.status} className="w-24 shrink-0" />
        <CaretRightIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-faint"
        />
      </button>
    </li>
  );
}

/**
 * Settings → Model service: every source a model can come from, in one list. Subscriptions the
 * gateway signs in to and providers in `config.json` are stored apart and stay apart; here they
 * are rows of the same list, opened the same way, added through the same three steps.
 */
export function ProviderSettings() {
  const { t: translateText } = useTranslation(["providers", "common"] as const);
  const { sources, error } = useSources();
  const [opened, setOpened] = useState<string>();
  const [adding, setAdding] = useState(false);
  if (error) return <LoadError what={translateText("title")} error={error} />;
  // A source that went away (removed here or elsewhere) leaves its page for the list.
  const open = sources?.find((source) => source.key === opened);
  if (open !== undefined)
    return <SourceDetail source={open} onBack={() => setOpened(undefined)} />;
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{translateText("title")}</h2>
        <Button
          size="sm"
          variant="outline"
          disabled={sources === undefined}
          onClick={() => setAdding(true)}
        >
          <PlusIcon aria-hidden="true" data-icon="inline-start" />
          {translateText("actions.add")}
        </Button>
      </div>
      {sources === undefined ? (
        <Loading rows={3} />
      ) : (
        <>
          <DefaultModel sources={sources} />
          {sources.length === 0 ? (
            <p className="border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
              {translateText("list.empty")}
            </p>
          ) : (
            <ul
              aria-label={translateText("list.label")}
              className="divide-y border"
            >
              {sources.map((source) => (
                <SourceRow
                  key={source.key}
                  source={source}
                  onOpen={() => setOpened(source.key)}
                />
              ))}
            </ul>
          )}
        </>
      )}
      {adding ? <AddSourceDialog open onOpenChange={setAdding} /> : null}
    </div>
  );
}
