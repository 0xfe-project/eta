import type {
  ProviderRefreshResult,
  ProviderSummary,
} from "@eta/client-contracts";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { listSeparator } from "@/lib/i18n";
import {
  keyMissing,
  providerErrorMessage,
  providerLabel,
  signsIn,
  useProviders,
  useRefreshProvider,
} from "@/queries/providers";
import { LlmAccounts } from "./llm-accounts";
import { ProviderEditor } from "./provider-editor";
import { useAgents } from "./use-agents";

function ProviderRow({
  provider,
  onEdit,
}: {
  provider: ProviderSummary;
  onEdit: () => void;
}) {
  const { t: translateText } = useTranslation(["providers", "common"] as const);
  const refresh = useRefreshProvider();
  const { agents } = useAgents();
  const providerName = providerLabel(provider);
  const required = keyMissing(provider);

  /**
   * What a refresh found. A catalog that says what it stopped listing (models.dev) gets a warning
   * naming those models and the agents that use them; the models themselves stay until removed.
   */
  const refreshed = (result: ProviderRefreshResult) => {
    if (result.delisted === undefined) {
      toast.success(
        translateText("refresh.done", { providerName, count: result.models }),
      );
      return;
    }
    if (result.delisted.length === 0) {
      toast.success(
        translateText("refresh.synced", {
          providerName,
          count: result.added?.length ?? 0,
        }),
      );
      return;
    }
    const gone = new Set(
      result.delisted.map((modelId) => `${provider.id}:${modelId}`),
    );
    const using = agents
      .filter((agent) => agent.model != null && gone.has(agent.model))
      .map((agent) =>
        translateText("common:format.quotedValue", { value: agent.name }),
      );
    const names = result.delisted.map(
      (modelId) =>
        provider.models.find((model) => model.id === modelId)?.name ?? modelId,
    );
    toast.warning(
      translateText("refresh.delisted", {
        providerName,
        models: names.join(listSeparator()),
      }),
      using.length === 0
        ? undefined
        : {
            description: translateText("refresh.delistedAgents", {
              agents: using.join(listSeparator()),
            }),
          },
    );
  };

  return (
    <li className="flex min-w-0 items-center gap-2 px-3 py-1.5">
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-xs">{provider.id}</span>
        <span className="block text-[11px] text-muted-foreground wrap-anywhere">
          {provider.kind} · {provider.baseUrl} ·{" "}
          <span className="whitespace-nowrap">
            {translateText("editor.modelCount", {
              count: provider.models.length,
            })}
          </span>
          {provider.hasApiKey || signsIn(provider) ? null : (
            <span
              className={
                required
                  ? "inline-flex items-center gap-1 text-destructive"
                  : ""
              }
            >
              {" · "}
              {required ? (
                <WarningIcon aria-hidden="true" className="size-3" />
              ) : null}
              {translateText("editor.keyMissing")}
            </span>
          )}
        </span>
      </span>
      {signsIn(provider) ? (
        <p className="text-xs text-muted-foreground">
          {translateText("editor.legacyCodex")}
        </p>
      ) : (
        <>
          <Button
            size="xs"
            variant="ghost"
            aria-label={translateText("common:actions.editItem", {
              name: providerName,
            })}
            onClick={onEdit}
          >
            {translateText("common:actions.edit")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={translateText("common:accessibility.itemActions", {
                  name: providerName,
                })}
              >
                <DotsThreeIcon aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem
                disabled={refresh.isPending}
                onSelect={() =>
                  refresh.mutate(
                    { id: provider.id },
                    {
                      onSuccess: refreshed,
                      onError: (error) =>
                        toast.error(providerErrorMessage(error)),
                    },
                  )
                }
              >
                {translateText("actions.refreshModels")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </li>
  );
}

/**
 * Settings → Model service: the providers in the config file, as rows you can edit.
 *
 * One row, one editor: a provider is one object in the file and the form is that object. What a
 * row says about a provider is what the config says (its kind, endpoint, models, whether a key is
 * set); the host reports nothing about whether an account works, so nothing here claims it does.
 */
export function ProviderSettings() {
  const { t: translateText } = useTranslation(["providers", "common"] as const);
  const { data, error } = useProviders();
  const [editing, setEditing] = useState<ProviderSummary | "new" | undefined>(
    undefined,
  );
  if (error) return <LoadError what={translateText("title")} error={error} />;
  // Editing replaces the list: it is one row's worth of the same column, and a person who is
  // looking at a form is not also choosing which provider to edit.
  if (editing !== undefined)
    return (
      <ProviderEditor
        key={editing === "new" ? "new" : editing.id}
        // The row as it is now, so a save shows in the editor that made it.
        provider={
          editing === "new"
            ? undefined
            : (data?.providers.find(
                (candidate) => candidate.id === editing.id,
              ) ?? editing)
        }
        onClose={() => setEditing(undefined)}
      />
    );
  return (
    <div className="space-y-4">
      <LlmAccounts />
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{translateText("title")}</h2>
          <Button
            size="sm"
            variant="outline"
            disabled={!data}
            onClick={() => setEditing("new")}
          >
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            {translateText("editor.newTitle")}
          </Button>
        </div>
        {!data ? (
          <Loading rows={2} />
        ) : data.providers.length === 0 ? (
          <p className="border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
            {translateText("editor.empty")}
          </p>
        ) : (
          <ul
            aria-label={translateText("editor.configured")}
            className="divide-y border"
          >
            {data.providers.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                onEdit={() => setEditing(provider)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
