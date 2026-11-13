import type {
  EtaModelConfig,
  LlmConnector,
  ProviderRefreshResult,
  ProviderSummary,
} from "@eta/client-contracts";
import type { ReactNode } from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/ArrowClockwise";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { listSeparator } from "@/lib/i18n";
import { llmProblemText } from "@/lib/llm-problem";
import { THINKING_LEVELS } from "@/lib/thinking";
import { cn } from "@/lib/utils";
import { useLlm } from "@/queries/llm";
import {
  discoveryErrorMessage,
  providerErrorMessage,
  providerLabel,
  useRefreshProvider,
  useSaveProvider,
} from "@/queries/providers";
import { Select, SelectOption } from "./select-field";
import { Tag } from "./source-parts";
import { abilityTags, formatContext } from "./source-text";
import { useAgents } from "./use-agents";

// A source's models as one compact table: what each is, how much it reads, what it can do, how
// hard it thinks by default, and whether agents can pick it. Every change is written at once.
// Turning a model off takes it out of `config.json`; it stays in the table, and a refreshed list
// offers it again.

/** The levels a model can be set to: the ones it declares, else every level the pickers offer. */
function levelsOf(model: EtaModelConfig): readonly string[] {
  const efforts = model.reasoningEfforts ?? [];
  if (efforts.length === 0) return THINKING_LEVELS;
  return [...(model.thinkingMode === "both" ? ["off"] : []), ...efforts];
}

function Th({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={cn(
        "border-b border-border-strong px-2 py-1 text-left font-mono text-[10.5px] font-normal tracking-wider text-faint uppercase",
        className,
      )}
    >
      {children}
    </th>
  );
}

/** The thinking level a model starts at; a model that says it does not reason has none. */
function ThinkingSelect({
  model,
  label,
  disabled,
  onChange,
}: {
  model: EtaModelConfig;
  label: string;
  disabled: boolean;
  onChange: (next: EtaModelConfig) => void;
}) {
  const { t: translateText } = useTranslation(["providers"] as const);
  if (model.reasoning === false) return <span className="text-faint">—</span>;
  return (
    <Select
      size="sm"
      aria-label={translateText("models.thinkingFor", { name: label })}
      className="h-6 w-full text-xs"
      disabled={disabled}
      value={model.defaultThinking ?? ""}
      onValueChange={(value) => {
        const next = { ...model };
        if (value === "") delete next.defaultThinking;
        else next.defaultThinking = value as EtaModelConfig["defaultThinking"];
        onChange(next);
      }}
    >
      <SelectOption value="">
        {translateText("models.followProvider")}
      </SelectOption>
      {levelsOf(model).map((level) => (
        <SelectOption key={level} value={level}>
          {level}
        </SelectOption>
      ))}
    </Select>
  );
}

/** The fields behind a row: manual values, which win over what any list says. */
function ModelFields({
  model,
  disabled,
  onSave,
}: {
  model: EtaModelConfig;
  disabled: boolean;
  onSave: (next: EtaModelConfig) => void;
}) {
  const { t: translateText } = useTranslation(["providers"] as const);
  const [name, setName] = useState(model.overrides?.name ?? "");
  const [window, setWindow] = useState(
    model.contextWindow === undefined ? "" : String(model.contextWindow),
  );
  const prefix = `model-${model.id}`;
  const commit = (patch: {
    name?: string;
    contextWindow?: string;
    vision?: boolean;
  }) => {
    const overrides = { ...model.overrides };
    const next: EtaModelConfig = { ...model };
    if (patch.name !== undefined) {
      const value = patch.name.trim();
      if (value === (model.overrides?.name ?? "")) return;
      if (value.length === 0) delete overrides.name;
      else next.name = overrides.name = value;
    }
    if (patch.contextWindow !== undefined) {
      const value = Number(patch.contextWindow.trim());
      if (!Number.isInteger(value) || value <= 0) {
        setWindow(
          model.contextWindow === undefined ? "" : String(model.contextWindow),
        );
        return;
      }
      if (value === model.contextWindow) return;
      next.contextWindow = overrides.contextWindow = value;
    }
    if (patch.vision !== undefined)
      next.input = overrides.input = patch.vision
        ? ["text", "image"]
        : ["text"];
    if (Object.keys(overrides).length > 0) next.overrides = overrides;
    else delete next.overrides;
    onSave(next);
  };
  return (
    <div className="grid max-w-xl grid-cols-[8rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 py-1 text-xs max-sm:grid-cols-1">
      <label htmlFor={`${prefix}-name`} className="text-muted-foreground">
        {translateText("models.displayName")}
      </label>
      <Input
        id={`${prefix}-name`}
        className="h-7 text-xs"
        value={name}
        disabled={disabled}
        placeholder={model.name ?? model.id}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => commit({ name })}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit({ name });
        }}
      />
      <label htmlFor={`${prefix}-window`} className="text-muted-foreground">
        {translateText("models.contextWindow")}
      </label>
      <Input
        id={`${prefix}-window`}
        className="h-7 font-mono text-xs"
        inputMode="numeric"
        value={window}
        disabled={disabled}
        onChange={(event) => setWindow(event.target.value)}
        onBlur={() => commit({ contextWindow: window })}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit({ contextWindow: window });
        }}
      />
      <span className="text-muted-foreground sm:hidden">
        {translateText("models.columns.thinking")}
      </span>
      <div className="sm:hidden">
        <ThinkingSelect
          model={model}
          label={model.name ?? model.id}
          disabled={disabled}
          onChange={onSave}
        />
      </div>
      <span className="max-sm:hidden" />
      <label className="flex items-center gap-2">
        <Checkbox
          checked={model.input?.includes("image") === true}
          disabled={disabled}
          onCheckedChange={(checked) => commit({ vision: checked === true })}
        />
        {translateText("models.visionInput")}
      </label>
    </div>
  );
}

/** The models of a provider in the config: switches, thinking levels and manual facts. */
export function ProviderModels({ provider }: { provider: ProviderSummary }) {
  const { t: translateText } = useTranslation(["providers", "common"] as const);
  const save = useSaveProvider();
  const refresh = useRefreshProvider();
  const { agents } = useAgents();
  const [listed, setListed] = useState<ProviderRefreshResult>();
  const [turnedOff, setTurnedOff] = useState<EtaModelConfig[]>([]);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<string>();
  const [confirming, setConfirming] = useState<EtaModelConfig>();
  const providerName = providerLabel(provider);

  const configured = provider.models;
  const on = new Set(configured.map((model) => model.id));
  const off = new Map<string, EtaModelConfig>();
  for (const model of [...turnedOff, ...(listed?.models ?? [])])
    if (!on.has(model.id) && !off.has(model.id)) off.set(model.id, model);
  const query = search.trim().toLowerCase();
  const matches = (model: { id: string; name?: string | undefined }) =>
    `${model.id} ${model.name ?? ""}`.toLowerCase().includes(query);
  const rows = [
    ...configured.map((model) => ({ model, enabled: true })),
    ...[...off.values()].map((model) => ({ model, enabled: false })),
  ].filter(({ model }) => matches(model));
  const unsupported = (listed?.unsupported ?? []).filter(matches);

  const write = (models: EtaModelConfig[]) =>
    save.mutate(
      {
        provider: {
          id: provider.id,
          ...(provider.name === undefined ? {} : { name: provider.name }),
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          models,
        },
      },
      { onError: (error) => toast.error(providerErrorMessage(error)) },
    );
  const usersOf = (model: EtaModelConfig) =>
    agents
      .filter((agent) => agent.model === `${provider.id}:${model.id}`)
      .map((agent) =>
        translateText("common:format.quotedValue", { value: agent.name }),
      );
  const turnOff = (model: EtaModelConfig) => {
    setTurnedOff((current) => [
      model,
      ...current.filter((other) => other.id !== model.id),
    ]);
    if (open === model.id) setOpen(undefined);
    write(configured.filter((other) => other.id !== model.id));
  };
  const toggle = (model: EtaModelConfig, enabled: boolean) => {
    if (enabled) {
      write([...configured, model]);
      return;
    }
    if (usersOf(model).length > 0) setConfirming(model);
    else turnOff(model);
  };
  const update = (next: EtaModelConfig) =>
    write(configured.map((model) => (model.id === next.id ? next : model)));

  const refreshList = () =>
    refresh.mutate(
      { id: provider.id },
      {
        onSuccess: (result) => {
          setListed(result);
          const delisted = result.delisted ?? [];
          if (delisted.length === 0) return;
          const gone = new Set(delisted.map((id) => `${provider.id}:${id}`));
          const using = agents
            .filter((agent) => agent.model != null && gone.has(agent.model))
            .map((agent) =>
              translateText("common:format.quotedValue", { value: agent.name }),
            );
          toast.warning(
            translateText("refresh.delisted", {
              providerName,
              models: delisted
                .map(
                  (id) =>
                    configured.find((model) => model.id === id)?.name ?? id,
                )
                .join(listSeparator()),
              count: delisted.length,
            }),
            using.length === 0
              ? undefined
              : {
                  description: translateText("refresh.delistedAgents", {
                    agents: using.join(listSeparator()),
                  }),
                },
          );
        },
        onError: (error) => toast.error(discoveryErrorMessage(error)),
      },
    );

  const busy = save.isPending;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
      <div className="flex items-center gap-2">
        <Input
          aria-label={translateText("models.search")}
          placeholder={translateText("models.search")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-7 max-w-64 text-xs"
        />
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          disabled={refresh.isPending}
          aria-busy={refresh.isPending}
          onClick={refreshList}
        >
          <ArrowClockwiseIcon
            aria-hidden="true"
            data-icon="inline-start"
            className={
              refresh.isPending ? "motion-safe:animate-spin" : undefined
            }
          />
          {translateText("actions.refreshList")}
        </Button>
      </div>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            <Th>{translateText("models.columns.name")}</Th>
            <Th className="w-16">{translateText("models.columns.context")}</Th>
            <Th className="max-sm:hidden">
              {translateText("models.columns.abilities")}
            </Th>
            <Th className="w-32 max-sm:hidden">
              {translateText("models.columns.thinking")}
            </Th>
            <Th className="w-12">{translateText("models.columns.enabled")}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ model, enabled }) => {
            const label = model.name ?? model.id;
            const expanded = enabled && open === model.id;
            const lastOne = enabled && configured.length === 1;
            return (
              <Fragment key={model.id}>
                <tr className="border-b">
                  <td
                    className={cn(
                      "min-w-0 px-2 py-1",
                      !enabled && "text-faint",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-1">
                      {enabled ? (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-expanded={expanded}
                          aria-label={translateText("models.edit", {
                            name: label,
                          })}
                          onClick={() =>
                            setOpen(expanded ? undefined : model.id)
                          }
                        >
                          {expanded ? (
                            <CaretDownIcon aria-hidden="true" />
                          ) : (
                            <CaretRightIcon aria-hidden="true" />
                          )}
                        </Button>
                      ) : (
                        <span className="size-6 shrink-0" />
                      )}
                      <span className="min-w-0 truncate" title={model.id}>
                        {label}
                      </span>
                      {model.delisted ? (
                        <Tag className="border-state-warning text-state-warning">
                          {translateText("models.delistedTag")}
                        </Tag>
                      ) : model.deprecated ? (
                        <Tag>{translateText("models.deprecated")}</Tag>
                      ) : null}
                    </span>
                  </td>
                  <td
                    className={cn(
                      "px-2 py-1 tabular-nums",
                      enabled ? "text-muted-foreground" : "text-faint",
                    )}
                  >
                    {formatContext(model.contextWindow)}
                  </td>
                  <td className="px-2 py-1 max-sm:hidden">
                    <span className="flex flex-wrap gap-1">
                      {abilityTags(model).map((tag) => (
                        <Tag key={tag}>{tag}</Tag>
                      ))}
                    </span>
                  </td>
                  <td className="px-2 py-1 max-sm:hidden">
                    {enabled ? (
                      <ThinkingSelect
                        model={model}
                        label={label}
                        disabled={busy}
                        onChange={update}
                      />
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td className="px-2 py-1">
                    <Switch
                      checked={enabled}
                      disabled={busy || lastOne}
                      title={
                        lastOne ? translateText("models.lastOne") : undefined
                      }
                      aria-label={translateText("models.enable", {
                        name: label,
                      })}
                      onCheckedChange={(checked) => toggle(model, checked)}
                    />
                  </td>
                </tr>
                {expanded ? (
                  <tr className="border-b bg-surface">
                    <td colSpan={5} className="px-2 py-1.5 pl-9">
                      <ModelFields
                        model={model}
                        disabled={busy}
                        onSave={update}
                      />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
          {unsupported.map((model) => (
            <tr key={`unsupported-${model.id}`} className="border-b text-faint">
              <td className="px-2 py-1 pl-9" colSpan={4}>
                <span className="truncate">{model.name ?? model.id}</span>
              </td>
              <td className="px-2 py-1 whitespace-nowrap">
                {translateText("models.unsupported")}
              </td>
            </tr>
          ))}
          {rows.length === 0 && unsupported.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-2 py-2 text-muted-foreground">
                {translateText("models.noMatches")}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <AlertDialog
        open={confirming !== undefined}
        onOpenChange={(next) => !next && setConfirming(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {translateText("models.turnOffTitle", {
                name: confirming?.name ?? confirming?.id ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {translateText("models.turnOffAgents", {
                agents: (confirming === undefined
                  ? []
                  : usersOf(confirming)
                ).join(listSeparator()),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {translateText("common:actions.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (confirming !== undefined) turnOff(confirming);
                setConfirming(undefined);
              }}
            >
              {translateText("models.turnOff")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The models a gateway account unlocks: the gateway decides which, so there is nothing to switch. */
export function AccountModels({ connector }: { connector: LlmConnector }) {
  const { t: translateText } = useTranslation(["providers"] as const);
  const { models } = useLlm();
  const own = models.filter((model) => model.connector === connector.id);
  if (own.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        {translateText("add.noModels")}
      </p>
    );
  return (
    <table className="w-full border-collapse text-xs">
      <thead>
        <tr>
          <Th>{translateText("models.columns.name")}</Th>
          <Th className="w-16">{translateText("models.columns.context")}</Th>
          <Th>{translateText("models.columns.state")}</Th>
        </tr>
      </thead>
      <tbody>
        {own.map((model) => (
          <tr key={model.id} className="border-b">
            <td className="px-2 py-1.5">
              <span className="truncate" title={model.id}>
                {model.name}
              </span>
            </td>
            <td className="px-2 py-1.5 tabular-nums text-muted-foreground">
              {formatContext(model.contextWindow)}
            </td>
            <td
              className={cn(
                "px-2 py-1.5",
                model.available ? "text-muted-foreground" : "text-state-error",
              )}
            >
              {model.available
                ? translateText("status.ok")
                : model.reason === undefined
                  ? translateText("models.unavailable")
                  : llmProblemText(model.reason)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
