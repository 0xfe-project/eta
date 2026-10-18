import type { Bundle, BundleDraft } from "@/queries/bundles";

import { PackageIcon } from "@phosphor-icons/react/Package";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Empty, LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { listSeparator, translate } from "@/lib/i18n";
import {
  translateBundleDescription,
  translatePluginDescription,
} from "@/lib/i18n-metadata";
import {
  bundleDraft,
  useBundles,
  useDeleteBundle,
  usePlugins,
  useUpdateBundle,
} from "@/queries/bundles";

// Bundles are what agents are built from: a script run into the agent's
// image and the plugins it adds, and a service some run in the cluster
// (the services' own manifests). eta's own are read only; the user's
// are edited here, and every agent that loads one is rebuilt.

const serviceStates: Record<string, string> = {
  get applying() {
    return translate("bundles:service.status.deploying");
  },
  get ready() {
    return translate("common:status.running");
  },
  get incompatible() {
    return translate("bundles:service.status.incompatibleProtocol");
  },
  get error() {
    return translate("common:status.error");
  },
};

function ServiceStatus({ bundle }: { bundle: Bundle }) {
  const { t: translateText } = useTranslation(["bundles", "common"] as const);
  if (!bundle.service) return null;
  const status = bundle.service_status;
  const state = status
    ? (serviceStates[status.state] ?? status.state)
    : translateText("common:status.unknown");
  return (
    <p className="text-xs text-muted-foreground">
      {translateText("service.summary", {
        runtime: state,
        status: status?.version ? ` · ${status.version}` : "",
        details: status?.message ? ` · ${status.message}` : "",
      })}
    </p>
  );
}

const showError = (error: Error) => toast.error(error.message);

function BundleDialog({
  bundle,
  open,
  onOpenChange,
}: {
  bundle: Bundle;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t: translateText } = useTranslation(["bundles", "common"] as const);
  const { data: plugins } = usePlugins();
  const save = useUpdateBundle();
  const [draft, setDraft] = useState<BundleDraft>(() => bundleDraft(bundle));
  const toggle = (name: string, on: boolean) =>
    setDraft((d) => ({
      ...d,
      plugins: on
        ? [...d.plugins, name]
        : d.plugins.filter((plugin) => plugin !== name),
    }));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{bundle.name}</DialogTitle>
          <DialogDescription>
            {translateText("editor.scriptHelp")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(draft, {
              onSuccess: () => {
                toast.success(translateText("common:feedback.saved"));
                onOpenChange(false);
              },
              onError: showError,
            });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="bundle-description">
              {translateText("editor.descriptionLabel")}
            </Label>
            <Input
              id="bundle-description"
              value={draft.description}
              maxLength={500}
              onChange={(e) =>
                setDraft((d) => ({ ...d, description: e.target.value }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bundle-script">
              {translateText("editor.scriptLabel")}
            </Label>
            <Textarea
              id="bundle-script"
              rows={8}
              spellCheck={false}
              className="max-h-[40dvh] min-h-32 font-mono text-xs leading-relaxed"
              placeholder={
                "apt-get update\napt-get install -y --no-install-recommends python3"
              }
              value={draft.script}
              onChange={(e) =>
                setDraft((d) => ({ ...d, script: e.target.value }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bundle-service">
              {translateText("editor.serviceLabel")}
            </Label>
            <Textarea
              id="bundle-service"
              rows={6}
              spellCheck={false}
              className="max-h-[40dvh] min-h-24 font-mono text-xs leading-relaxed"
              placeholder={translateText("editor.manifestsPlaceholder", {
                bundleName: bundle.name,
                serviceName: bundle.name,
              })}
              value={draft.manifests}
              onChange={(e) =>
                setDraft((d) => ({ ...d, manifests: e.target.value }))
              }
            />
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              <Label className="gap-2">
                <Checkbox
                  checked={draft.usesModels}
                  onCheckedChange={(on) =>
                    setDraft((d) => ({ ...d, usesModels: on === true }))
                  }
                />
                {translateText("editor.callableModels")}
              </Label>
              <Label className="gap-2">
                <Checkbox
                  checked={draft.database}
                  onCheckedChange={(on) =>
                    setDraft((d) => ({ ...d, database: on === true }))
                  }
                />
                {translateText("editor.separateDatabase")}
              </Label>
            </div>
          </div>
          {plugins?.length ? (
            <div
              role="group"
              aria-labelledby="bundle-plugins"
              className="space-y-1.5"
            >
              <p id="bundle-plugins" className="text-xs leading-none">
                {translateText("editor.pluginsLabel")}
              </p>
              <ul className="divide-y border">
                {plugins.map((plugin) => (
                  <li key={plugin.name}>
                    <Label className="items-start gap-3 p-2.5 leading-snug">
                      <Checkbox
                        className="mt-px"
                        checked={draft.plugins.includes(plugin.name)}
                        onCheckedChange={(on) =>
                          toggle(plugin.name, on === true)
                        }
                      />
                      <span className="min-w-0 space-y-0.5">
                        <span className="block font-medium">{plugin.name}</span>
                        <span className="block text-muted-foreground">
                          {translatePluginDescription(
                            plugin.name,
                            plugin.description,
                          )}
                        </span>
                      </span>
                    </Label>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={save.isPending}>
              {translateText("common:actions.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function BundleSettings() {
  const { t: translateText } = useTranslation(["bundles", "common"] as const);
  const { data: bundles, isPending, error, refetch } = useBundles();
  const remove = useDeleteBundle();
  const [editing, setEditing] = useState<Bundle | null>(null);
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold">{translateText("title")}</h2>
      <p className="text-xs text-muted-foreground">
        {translateText("description")}
      </p>
      {error ? (
        <LoadError
          what={translateText("title")}
          error={error}
          onRetry={() => void refetch()}
        />
      ) : isPending ? (
        <Loading rows={4} />
      ) : !bundles.length ? (
        <Empty icon={PackageIcon} title={translateText("empty.title")} />
      ) : (
        <ul className="divide-y border">
          {bundles.map((bundle) => (
            <li
              key={bundle.name}
              className="flex items-start gap-3 p-2.5 text-sm"
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="font-medium">
                  {bundle.name}
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                    {bundle.builtin
                      ? translateText("common:labels.builtIn")
                      : translateText("common:labels.custom")}
                  </span>
                </p>
                {bundle.description ? (
                  <p className="text-muted-foreground">
                    {translateBundleDescription(
                      bundle.name,
                      bundle.description,
                    )}
                  </p>
                ) : null}
                {bundle.plugins.length ? (
                  <p className="text-xs text-muted-foreground">
                    {translateText("plugins.summary", {
                      plugins: bundle.plugins.join(listSeparator()),
                    })}
                  </p>
                ) : null}
                <ServiceStatus bundle={bundle} />
              </div>
              {bundle.builtin ? null : (
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditing(bundle)}
                  >
                    {translateText("common:actions.edit")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={remove.isPending}
                    onClick={() =>
                      remove.mutate(bundle.name, {
                        onSuccess: () =>
                          toast.success(
                            translateText("common:feedback.deletedItem", {
                              name: bundle.name,
                            }),
                          ),
                        onError: showError,
                      })
                    }
                  >
                    {translateText("common:actions.delete")}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing !== null ? (
        <BundleDialog
          key={editing.name}
          bundle={editing}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}
