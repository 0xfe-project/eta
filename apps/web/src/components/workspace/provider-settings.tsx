import type { Source } from "@/queries/sources";
import { BUILTIN_PROVIDER_PRESETS } from "@eta/client-contracts";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { logoOf, useSourceLogos } from "@/queries/logos";
import { useSources } from "@/queries/sources";
import { AddSourceDialog } from "./add-source-dialog";
import { SourceDetail } from "./source-detail";
import { QuotaMeter, SourceLogo, StatusLabel } from "./source-parts";
import { viaText } from "./source-text";

function SourceRow({
  source,
  logo,
  onOpen,
}: {
  source: Source;
  logo: string | undefined;
  onOpen: () => void;
}) {
  const { t: translateText } = useTranslation(["providers"] as const);
  return (
    <li>
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2.5 px-2.5 py-2 text-left duration-[60ms] ease-linear hover:bg-overlay-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        onClick={onOpen}
      >
        <SourceLogo name={source.name} svg={logo} />
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
  const logos = useSourceLogos();
  const [opened, setOpened] = useState<string>();
  // `true` opens the first step; a preset's id opens straight on its connect step.
  const [adding, setAdding] = useState<boolean | string>(false);
  if (error) return <LoadError what={translateText("title")} error={error} />;
  // A source that went away (removed here or elsewhere) leaves its page for the list.
  const open = sources?.find((source) => source.key === opened);
  if (open !== undefined)
    return (
      <SourceDetail
        source={open}
        logo={logoOf(logos, open)}
        onBack={() => setOpened(undefined)}
      />
    );
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
          {sources.length === 0 ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border border-dashed px-3 py-2.5 text-xs">
              <p className="min-w-0 flex-1 text-muted-foreground">
                {translateText("list.empty")}
              </p>
              <Button size="sm" onClick={() => setAdding("eta")}>
                {translateText("list.addEta", {
                  name: BUILTIN_PROVIDER_PRESETS.eta.name,
                })}
              </Button>
            </div>
          ) : (
            <ul
              aria-label={translateText("list.label")}
              className="divide-y border"
            >
              {sources.map((source) => (
                <SourceRow
                  key={source.key}
                  source={source}
                  logo={logoOf(logos, source)}
                  onOpen={() => setOpened(source.key)}
                />
              ))}
            </ul>
          )}
        </>
      )}
      {adding === false ? null : (
        <AddSourceDialog
          open
          onOpenChange={setAdding}
          {...(adding === true ? {} : { initialPreset: adding })}
        />
      )}
    </div>
  );
}
