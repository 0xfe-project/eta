import type { Bundle, BundleDraft } from "@/queries/chat";

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
  bundleDraft,
  useBundles,
  useDeleteBundle,
  usePlugins,
  useUpdateBundle,
} from "@/queries/chat";

// Bundles are what agents are built from: a script run into the agent's
// image and the plugins it adds, and a service some run in the cluster
// (docs/architecture/bundles.md#服务). AXP's own are read only; the user's
// are edited here, and every agent that loads one is rebuilt.

const serviceStates: Record<string, string> = {
  get applying() {
    return translate("部署中");
  },
  get ready() {
    return translate("运行中");
  },
  get incompatible() {
    return translate("协议不兼容");
  },
  get error() {
    return translate("出错");
  },
};

function ServiceStatus({ bundle }: { bundle: Bundle }) {
  const { t: translateText } = useTranslation();
  if (!bundle.service) return null;
  const status = bundle.service_status;
  const state = status
    ? (serviceStates[status.state] ?? status.state)
    : translateText("未知");
  return (
    <p className="text-xs text-muted-foreground">
      {translateText("服务：{{value1}}{{value2}}{{value3}}", {
        value1: state,
        value2: status?.version ? ` · ${status.version}` : "",
        value3: status?.message ? ` · ${status.message}` : "",
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
  const { t: translateText } = useTranslation();
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
            {translateText(
              "脚本在构建智能体环境时以 root 运行；用到它的智能体会重新构建。",
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(draft, {
              onSuccess: () => {
                toast.success(translateText("已保存"));
                onOpenChange(false);
              },
              onError: showError,
            });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="bundle-description">{translateText("说明")}</Label>
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
            <Label htmlFor="bundle-script">{translateText("脚本")}</Label>
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
            <Label htmlFor="bundle-service">{translateText("服务")}</Label>
            <Textarea
              id="bundle-service"
              rows={6}
              spellCheck={false}
              className="max-h-[40dvh] min-h-24 font-mono text-xs leading-relaxed"
              placeholder={translateText(
                "# 可选：在集群里运行的 Kubernetes 对象，载入它的智能体经 /bundles/{{value1}}/ 访问\n# 需要一个名为 {{value2}}、端口名 http 的 Service",
                { value1: bundle.name, value2: bundle.name },
              )}
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
                {translateText("可调用模型")}
              </Label>
              <Label className="gap-2">
                <Checkbox
                  checked={draft.database}
                  onCheckedChange={(on) =>
                    setDraft((d) => ({ ...d, database: on === true }))
                  }
                />
                {translateText("独立数据库")}
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
                {translateText("插件")}
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
                          {translateText(plugin.description, {
                            defaultValue: plugin.description,
                          })}
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
              {translateText("保存")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function BundleSettings() {
  const { t: translateText } = useTranslation();
  const { data: bundles, isPending, error, refetch } = useBundles();
  const remove = useDeleteBundle();
  const [editing, setEditing] = useState<Bundle | null>(null);
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold">{translateText("环境包")}</h2>
      <p className="text-xs text-muted-foreground">
        {translateText(
          "智能体的环境由它选择的环境包构建：脚本装好工具，插件带来 MCP、技能和钩子。",
        )}
      </p>
      {error ? (
        <LoadError
          what={translateText("环境包")}
          error={error}
          onRetry={() => void refetch()}
        />
      ) : isPending ? (
        <Loading rows={4} />
      ) : !bundles.length ? (
        <Empty icon={PackageIcon} title={translateText("还没有环境包")} />
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
                      ? translateText("内置")
                      : translateText("自定义")}
                  </span>
                </p>
                {bundle.description ? (
                  <p className="text-muted-foreground">
                    {translateText(bundle.description, {
                      defaultValue: bundle.description,
                    })}
                  </p>
                ) : null}
                {bundle.plugins.length ? (
                  <p className="text-xs text-muted-foreground">
                    {translateText("插件：{{value1}}", {
                      value1: bundle.plugins.join(listSeparator()),
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
                    {translateText("编辑")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={remove.isPending}
                    onClick={() =>
                      remove.mutate(bundle.name, {
                        onSuccess: () =>
                          toast.success(
                            translateText("已删除「{{value1}}」", {
                              value1: bundle.name,
                            }),
                          ),
                        onError: showError,
                      })
                    }
                  >
                    {translateText("删除")}
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
