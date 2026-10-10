import type { Bundle, BundleDraft } from "@/queries/chat";
import { PackageIcon } from "@phosphor-icons/react/Package";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { useState } from "react";
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
import {
  useBundles,
  useDeleteBundle,
  usePlugins,
  useSaveBundle,
} from "@/queries/chat";

// Bundles are what agents are built from: a script run into the agent's
// image and the plugins it adds. AXP's own are read only; the user's are
// edited here, and every agent that loads one is rebuilt.

const showError = (error: Error) => toast.error(error.message);
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

function BundleDialog({
  bundle,
  open,
  onOpenChange,
}: {
  /** The bundle to edit; a new one when undefined. */
  bundle: Bundle | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: plugins } = usePlugins();
  const save = useSaveBundle();
  const [draft, setDraft] = useState<BundleDraft>(
    bundle ?? { name: "", description: "", script: "", plugins: [] },
  );
  const creating = bundle === undefined;
  const nameInvalid = creating && draft.name !== "" && !NAME.test(draft.name);
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
          <DialogTitle>{creating ? "新建环境包" : bundle.name}</DialogTitle>
          <DialogDescription>
            脚本在构建智能体环境时以 root 运行；用到它的智能体会重新构建。
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!NAME.test(draft.name)) return;
            save.mutate(
              { draft, creating },
              {
                onSuccess: () => {
                  toast.success(
                    creating ? `已创建「${draft.name}」` : "已保存",
                  );
                  onOpenChange(false);
                },
                onError: showError,
              },
            );
          }}
        >
          {creating ? (
            <div className="space-y-1.5">
              <Label htmlFor="bundle-name">名称</Label>
              <Input
                id="bundle-name"
                autoFocus
                value={draft.name}
                placeholder="例如：python"
                aria-invalid={nameInvalid}
                aria-describedby="bundle-name-hint"
                onChange={(e) =>
                  setDraft((d) => ({ ...d, name: e.target.value }))
                }
              />
              <p
                id="bundle-name-hint"
                className={
                  nameInvalid
                    ? "text-xs text-destructive"
                    : "text-xs text-muted-foreground"
                }
              >
                小写字母、数字和连字符，最多 40 个字符。
              </p>
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="bundle-description">说明</Label>
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
            <Label htmlFor="bundle-script">脚本</Label>
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
          {plugins?.length ? (
            <div
              role="group"
              aria-labelledby="bundle-plugins"
              className="space-y-1.5"
            >
              <p id="bundle-plugins" className="text-xs leading-none">
                插件
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
                          {plugin.description}
                        </span>
                      </span>
                    </Label>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="submit"
              disabled={save.isPending || !NAME.test(draft.name)}
            >
              {creating ? "创建" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function BundleSettings() {
  const { data: bundles, isPending, error, refetch } = useBundles();
  const remove = useDeleteBundle();
  // The dialog: closed (null), a new bundle (undefined) or one to edit.
  const [editing, setEditing] = useState<Bundle | undefined | null>(null);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">环境包</h2>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setEditing(undefined)}
        >
          <PlusIcon aria-hidden="true" />
          新建
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        智能体的环境由它选择的环境包构建：脚本装好工具，插件带来
        MCP、技能和钩子。
      </p>
      {error ? (
        <LoadError what="环境包" error={error} onRetry={() => void refetch()} />
      ) : isPending ? (
        <Loading rows={4} />
      ) : !bundles.length ? (
        <Empty icon={PackageIcon} title="还没有环境包" />
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
                    {bundle.builtin ? "内置" : "自定义"}
                  </span>
                </p>
                {bundle.description ? (
                  <p className="text-muted-foreground">{bundle.description}</p>
                ) : null}
                {bundle.plugins.length ? (
                  <p className="text-xs text-muted-foreground">
                    插件：{bundle.plugins.join("、")}
                  </p>
                ) : null}
              </div>
              {bundle.builtin ? null : (
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditing(bundle)}
                  >
                    编辑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={remove.isPending}
                    onClick={() =>
                      remove.mutate(bundle.name, {
                        onSuccess: () =>
                          toast.success(`已删除「${bundle.name}」`),
                        onError: showError,
                      })
                    }
                  >
                    删除
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing !== null ? (
        <BundleDialog
          key={editing?.name ?? "new"}
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
