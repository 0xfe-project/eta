import type { Bundle } from "@/api/control-plane.gen";
import type { GitHubStatus } from "@/queries/forge";
import type { Connection } from "@/queries/llm";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { GithubLogoIcon } from "@phosphor-icons/react/GithubLogo";
import { ImageIcon } from "@phosphor-icons/react/Image";
import { PuzzlePieceIcon } from "@phosphor-icons/react/PuzzlePiece";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Markdown } from "@/components/markdown";
import { LoadError, Loading } from "@/components/states";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { translate } from "@/lib/i18n";
import {
  useBundleConfig,
  useClearBundleConfig,
  useSetBundleConfig,
} from "@/queries/bundle-config";
import { useBundles } from "@/queries/chat";
import { useGitHubStatus, useRefreshGitHub } from "@/queries/forge";
import {
  GROK_CONNECTOR,
  NEEDS_ACTION,
  USABLE,
  useConnections,
  useConnectors,
  useUsage,
} from "@/queries/llm";
import { connectionStateLabels } from "./connection-state";
import { GitHubWizard } from "./github-wizard";
import { ConnectorSection, RefreshStatus } from "./provider-settings";
import { useWorkspaceStore } from "./workspace-store";

interface Summary {
  summary: string;
  /** Set when the user has something to do. */
  todo?: string;
}

/** One connection: its state at a glance; opening it sets it up. */
function ConnectionCard({
  icon: Icon,
  name,
  summary,
  todo,
  onOpen,
}: Summary & {
  icon: typeof GithubLogoIcon;
  name: string;
  onOpen: () => void;
}) {
  useTranslation();
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex items-start gap-3 border bg-card p-3 text-left transition-colors duration-[60ms] ease-linear outline-none hover:bg-muted/40 focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span className="flex size-8 shrink-0 items-center justify-center bg-muted">
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{name}</span>
          {todo ? <Badge variant="outline">{todo}</Badge> : null}
        </span>
        <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
          {summary}
        </span>
      </span>
      <CaretRightIcon
        aria-hidden="true"
        className="mt-2 size-3.5 shrink-0 text-muted-foreground transition-transform duration-[60ms] ease-linear group-hover:translate-x-0.5 motion-reduce:transition-none"
      />
    </button>
  );
}

/** What the GitHub App does now, and what is left for the user to do. */
function githubSummary(status: GitHubStatus): Summary {
  switch (status.state) {
    case "ready":
      return {
        summary: status.user
          ? translate("智能体以 {{value1}} 的名义使用 GitHub", {
              value1: status.user.login,
            })
          : translate("智能体以 {{value1}}[bot] 的身份使用 GitHub", {
              value1: status.app?.slug,
            }),
      };
    case "not_installed":
      return {
        summary: translate("App 已创建，还需安装到仓库"),
        todo: translate("待安装"),
      };
    case "error":
      return {
        summary: status.error?.message ?? translate("连接出错"),
        todo: translate("出错"),
      };
    default:
      return {
        summary: translate("推送代码、处理 PR、创建仓库、读取 CI"),
        todo: translate("未连接"),
      };
  }
}

// Query parameters GitHub and the forge service send the browser back with.
const RETURN_PARAMS = [
  "github",
  "github_error",
  "installation_id",
  "setup_action",
];

/**
 * Coming back from GitHub (App created, installed or failed): reopen the
 * wizard where it now stands and drop the parameters from the address.
 */
function useReturnFromGitHub(onReturn: (error: string | undefined) => void) {
  const { t: translateText } = useTranslation();
  const refresh = useRefreshGitHub();
  useEffect(() => {
    const url = new URL(window.location.href);
    const params = url.searchParams;
    if (!RETURN_PARAMS.some((name) => params.has(name))) return;
    const error = params.get("github_error") ?? undefined;
    if (!error && params.get("github") === "created")
      toast.success(translateText("GitHub App 已创建"));
    else if (!error && params.get("github") === "authorized")
      toast.success(translateText("已授权，智能体将以你的名义使用 GitHub"));
    else if (!error && params.get("setup_action"))
      toast.success(translateText("已在 GitHub 上安装 App"));
    for (const name of RETURN_PARAMS) params.delete(name);
    window.history.replaceState(window.history.state, "", url);
    onReturn(error);
    void refresh();
  }, [onReturn, refresh, translateText]);
}

function GitHubConnection() {
  const { t: translateText } = useTranslation();
  const { data: status, error } = useGitHubStatus();
  const [open, setOpen] = useState(false);
  const [returned, setReturned] = useState<{ error?: string }>();
  useReturnFromGitHub(
    useCallback((error: string | undefined) => {
      setReturned({ error });
      setOpen(true);
    }, []),
  );
  // Loading shows what it is for; the wizard shows a failed load in full.
  const current: Summary = status
    ? githubSummary(status)
    : error
      ? {
          summary: translateText("无法加载连接状态"),
          todo: translateText("出错"),
        }
      : { summary: translateText("推送代码、处理 PR、创建仓库、读取 CI") };

  return (
    <>
      <ConnectionCard
        icon={GithubLogoIcon}
        name="GitHub"
        {...current}
        onOpen={() => setOpen(true)}
      />
      <GitHubWizard
        // A return from GitHub starts the wizard over where it now stands.
        key={returned ? `returned-${returned.error ?? ""}` : "wizard"}
        open={open}
        onOpenChange={setOpen}
        returnError={returned?.error}
      />
    </>
  );
}

const grokDescription = () => translate("生成图片和视频，搜索网页与 X");

function grokSummary(accounts: Connection[] | undefined): Summary {
  if (!accounts) return { summary: grokDescription() };
  const active = accounts.find((account) => USABLE.has(account.state));
  if (active)
    return {
      summary: translate("用 {{value1}} {{value2}}", {
        value1: active.label,
        value2: grokDescription(),
      }),
    };
  const stuck = accounts.find((account) => NEEDS_ACTION.has(account.state));
  if (stuck)
    return {
      summary: stuck.error?.message ?? stuck.label,
      todo: connectionStateLabels[stuck.state],
    };
  if (accounts.length)
    return {
      summary: accounts[0].label,
      todo: connectionStateLabels[accounts[0].state],
    };
  return { summary: grokDescription(), todo: translate("未绑定") };
}

/**
 * Grok's account is the model gateway's xAI account: the same one serves
 * Grok models and the grok plugin's images, videos and search.
 */
function GrokConnection() {
  const { t: translateText } = useTranslation();
  const setSettings = useWorkspaceStore((s) => s.setSettings);
  const connectors = useConnectors();
  const connections = useConnections();
  const { data: usage } = useUsage();
  const [open, setOpen] = useState(false);
  const connector = connectors.data?.find((item) => item.id === GROK_CONNECTOR);
  const accounts = connections.data?.filter(
    (connection) => connection.connector === GROK_CONNECTOR,
  );
  const failed = connectors.error ?? connections.error;
  const current: Summary = failed
    ? { summary: failed.message, todo: translateText("出错") }
    : grokSummary(accounts);

  return (
    <>
      <ConnectionCard
        icon={ImageIcon}
        name="Grok"
        {...current}
        onOpen={() => setOpen(true)}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-lg">
          <DialogHeader className="flex-row items-center gap-2">
            <ImageIcon aria-hidden="true" className="size-5" />
            <DialogTitle className="text-sm">Grok</DialogTitle>
          </DialogHeader>
          {failed ? (
            <LoadError
              what={translateText("Grok 账号")}
              error={failed}
              onRetry={() => {
                void connectors.refetch();
                void connections.refetch();
              }}
            />
          ) : connector && accounts ? (
            <>
              <RefreshStatus className="justify-end" />
              <ConnectorSection
                connector={connector}
                connections={accounts}
                usage={usage}
                hideHeading
                description={
                  <>
                    {translateText("与")}
                    <Button
                      variant="link"
                      size="xs"
                      className="h-auto px-1"
                      onClick={() => {
                        setOpen(false);
                        setSettings({ open: true, section: "providers" });
                      }}
                    >
                      {translateText("模型服务")}
                    </Button>
                    {translateText("里的 Grok 是同一账号，也提供 Grok 模型")}
                  </>
                }
              />
            </>
          ) : (
            <Loading rows={1} />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * What config.schema.json (apps/control-plane internal/bundles) lets a
 * bundle's config say, which the control plane checked when it read it.
 */
interface ConfigSchema {
  required?: string[];
  properties: Record<
    string,
    {
      title?: string;
      description?: string;
      writeOnly?: boolean;
      maxLength: number;
    }
  >;
}

type Configured = Bundle & { config: ConfigSchema };

/**
 * A bundle's config as a form, built from its schema: one field per
 * property, secrets write-only (left blank, the saved one stays).
 */
function BundleConfigForm({
  bundle,
  set,
  values,
  onClose,
}: {
  bundle: Configured;
  set: string[];
  values: Record<string, string>;
  onClose: () => void;
}) {
  const { t: translateText } = useTranslation();
  const save = useSetBundleConfig(bundle.name);
  const clear = useClearBundleConfig(bundle.name);
  const { properties, required = [] } = bundle.config;
  const [draft, setDraft] = useState<Record<string, string>>(values);
  const id = useId();
  const changes = () => {
    const out: Record<string, string | null> = {};
    for (const [name, property] of Object.entries(properties)) {
      const value = (draft[name] ?? "").trim();
      if (property.writeOnly && value === "") continue;
      if (value !== (values[name] ?? "")) out[name] = value || null;
    }
    return out;
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(changes(), {
          onSuccess: (state) => {
            toast.success(
              state.ready
                ? translateText("已保存，载入它的智能体空闲时会重启")
                : translateText("已保存，还有必填项未填"),
            );
            onClose();
          },
          onError: (error) => toast.error(error.message),
        });
      }}
    >
      {Object.entries(properties).map(([name, property]) => {
        const saved = set.includes(name);
        return (
          <div key={name} className="space-y-1">
            <label htmlFor={`${id}-${name}`} className="text-xs font-medium">
              {property.title
                ? translateText(property.title, {
                    defaultValue: property.title,
                  })
                : name}
              {required.includes(name) ? null : (
                <span className="font-normal text-muted-foreground">
                  {translateText(" （可选）")}
                </span>
              )}
            </label>
            <Input
              id={`${id}-${name}`}
              type={property.writeOnly ? "password" : "text"}
              value={draft[name] ?? ""}
              required={required.includes(name) && !saved}
              maxLength={property.maxLength}
              autoComplete="off"
              spellCheck={false}
              placeholder={
                property.writeOnly && saved
                  ? translateText("已设置，留空不替换")
                  : undefined
              }
              onChange={(e) =>
                setDraft((d) => ({ ...d, [name]: e.target.value }))
              }
            />
            {property.description ? (
              <Markdown className="text-xs text-muted-foreground">
                {translateText(property.description, {
                  defaultValue: property.description,
                })}
              </Markdown>
            ) : null}
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        {translateText(
          "这些值加密保存在 AXP，作为环境变量交给载入“{{value1}}”环境包的智能体。",
          { value1: bundle.name },
        )}
      </p>
      <DialogFooter className="gap-2 sm:justify-end">
        {set.length > 0 ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="text-muted-foreground sm:mr-auto"
              >
                {translateText("清除配置")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {translateText("清除 {{value1}} 的配置？", {
                    value1: bundle.name,
                  })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {translateText(
                    "AXP 会删除保存的值。载入这个环境包的智能体空闲时重启，之后不再有它的插件。",
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{translateText("取消")}</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() =>
                    clear.mutate(undefined, {
                      onSuccess: () => {
                        toast.success(translateText("已清除配置"));
                        onClose();
                      },
                      onError: (error) => toast.error(error.message),
                    })
                  }
                >
                  {translateText("清除")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? translateText("正在保存…") : translateText("保存")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** A built-in bundle that asks the user for values (its config schema). */
function BundleConnection({ bundle }: { bundle: Configured }) {
  const { t: translateText } = useTranslation();
  const { data, error, refetch } = useBundleConfig(bundle.name);
  const [open, setOpen] = useState(false);
  const current: Summary = error
    ? { summary: error.message, todo: translateText("出错") }
    : data && !data.ready
      ? {
          summary: translateText(bundle.description, {
            defaultValue: bundle.description,
          }),
          todo: translateText("未配置"),
        }
      : {
          summary: translateText(bundle.description, {
            defaultValue: bundle.description,
          }),
        };

  return (
    <>
      <ConnectionCard
        icon={PuzzlePieceIcon}
        name={bundle.name}
        {...current}
        onOpen={() => setOpen(true)}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-lg">
          <DialogHeader className="flex-row items-center gap-2">
            <PuzzlePieceIcon aria-hidden="true" className="size-5" />
            <DialogTitle className="text-sm">{bundle.name}</DialogTitle>
          </DialogHeader>
          {error ? (
            <LoadError
              what={translateText("配置")}
              error={error}
              onRetry={() => void refetch()}
            />
          ) : data ? (
            <BundleConfigForm
              key={data.updated_at ?? "new"}
              bundle={bundle}
              set={data.set}
              values={data.values}
              onClose={() => setOpen(false)}
            />
          ) : (
            <Loading rows={1} />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Settings → 连接: the integrations the user has to set up themselves. */
export function ConnectionSettings() {
  const { t: translateText } = useTranslation();
  const bundles = useBundles();
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold">{translateText("连接")}</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        <GitHubConnection />
        <GrokConnection />
        {bundles.data
          ?.filter((b): b is Configured => b.builtin && !!b.config)
          .map((b) => (
            <BundleConnection key={b.name} bundle={b} />
          ))}
      </div>
    </div>
  );
}
