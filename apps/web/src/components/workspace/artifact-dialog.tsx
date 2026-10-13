import type { ArtifactVersion } from "@/queries/artifacts";
import { AppWindowIcon } from "@phosphor-icons/react/AppWindow";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { DownloadSimpleIcon } from "@phosphor-icons/react/DownloadSimple";
import { GlobeIcon } from "@phosphor-icons/react/Globe";
import { useState } from "react";
import { toast } from "sonner";
import { LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { archiveURL, useArtifact, useShareArtifact } from "@/queries/artifacts";

/**
 * An artifact's page in a dialog: large on a desktop, nearly the whole
 * screen on a phone. The site runs in a sandboxed frame (an opaque origin:
 * no cookies, storage or AXP API), loaded from its version's preview
 * address, which works without cookies; the same policy holds when it is
 * opened in a new window.
 */
const SANDBOX =
  "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

function ArtifactDialog({
  id,
  version,
  open,
  onOpenChange,
}: {
  id: string;
  /** The version to show first; the latest when absent or gone. */
  version?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const artifact = useArtifact(id, open);
  const [chosen, setChosen] = useState<number | undefined>(version);
  const versions = artifact.data?.versions ?? [];
  const current =
    versions.find((v) => v.number === chosen) ?? versions.at(0) ?? null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[calc(100dvh-1rem)] max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:h-[calc(100dvh-4rem)] sm:max-w-[min(96rem,calc(100%-4rem))]">
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2 pr-11">
          <AppWindowIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          <DialogTitle className="min-w-0 flex-1 truncate">
            {artifact.data?.title ?? "Artifact"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            智能体发布的静态网页，在沙箱里运行，不能访问 AXP 的登录状态和接口。
          </DialogDescription>
          {current && artifact.data ? (
            <div className="flex w-full items-center gap-1 sm:w-auto">
              {versions.length > 1 ? (
                <select
                  aria-label="版本"
                  value={current.number}
                  onChange={(e) => setChosen(Number(e.target.value))}
                  className="h-7 border bg-background px-1.5 text-xs tabular-nums"
                >
                  {versions.map((v) => (
                    <option key={v.number} value={v.number}>
                      第 {v.number} 版
                      {v.number === versions[0].number ? "（最新）" : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="px-1 text-xs text-muted-foreground tabular-nums">
                  第 {current.number} 版
                </span>
              )}
              <span className="flex-1 sm:hidden" />
              <ShareControl id={id} version={current} />
              <Button variant="ghost" size="sm" asChild>
                <a
                  href={current.preview_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ArrowSquareOutIcon aria-hidden="true" />
                  <span className="max-sm:sr-only">新窗口打开</span>
                </a>
              </Button>
              <Button variant="ghost" size="sm" asChild>
                <a href={archiveURL(id, current.number)} download>
                  <DownloadSimpleIcon aria-hidden="true" />
                  <span className="max-sm:sr-only">下载</span>
                </a>
              </Button>
            </div>
          ) : null}
        </div>
        {current?.share ? <ShareLink url={current.share.url} /> : null}
        <div className="relative min-h-0 flex-1 bg-white">
          {artifact.isPending ? (
            <Loading layout="detail" className="p-6" label="正在打开…" />
          ) : artifact.error ? (
            <LoadError
              what="这个 Artifact"
              error={artifact.error}
              onRetry={() => void artifact.refetch()}
            />
          ) : current ? (
            <iframe
              key={current.number}
              title={artifact.data.title}
              src={current.preview_url}
              sandbox={SANDBOX}
              referrerPolicy="no-referrer"
              className="absolute inset-0 size-full border-0"
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Making the shown version public, or ending its link. */
function ShareControl({
  id,
  version,
}: {
  id: string;
  version: ArtifactVersion;
}) {
  const share = useShareArtifact(id);
  const shared = Boolean(version.share);
  return (
    <Button
      variant={shared ? "secondary" : "ghost"}
      size="sm"
      disabled={share.isPending}
      title={
        shared
          ? "撤销后链接立即失效，再次分享会生成新链接"
          : "生成公开链接：任何拿到链接的人都能打开这个版本"
      }
      onClick={() =>
        share.mutate(
          { version: version.number, share: !shared },
          {
            onSuccess: () =>
              toast(shared ? "已撤销公开链接" : "已生成公开链接"),
            onError: (error) => toast.error(error.message),
          },
        )
      }
    >
      <GlobeIcon aria-hidden="true" />
      <span className="max-sm:sr-only">{shared ? "撤销分享" : "公开分享"}</span>
    </Button>
  );
}

function ShareLink({ url }: { url: string }) {
  const link = new URL(url, window.location.origin).href;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs">
      <span className="shrink-0 text-muted-foreground">公开链接</span>
      <a
        href={link}
        target="_blank"
        rel="noopener noreferrer"
        className="min-w-0 flex-1 truncate font-mono underline-offset-4 hover:underline"
      >
        {link}
      </a>
      <Button
        variant="ghost"
        size="xs"
        onClick={() =>
          void navigator.clipboard
            .writeText(link)
            .then(() => toast("已复制链接"))
            .catch(() => toast.error("复制失败：浏览器不允许访问剪贴板"))
        }
      >
        <CopyIcon aria-hidden="true" />
        复制
      </Button>
    </div>
  );
}

/**
 * An artifact's version as something to click (a transcript's card, a
 * task's timeline): it opens the dialog.
 */
export function ArtifactButton({
  id,
  version,
  className,
  children,
  ...props
}: {
  id: string;
  version?: number;
  className?: string;
  children: React.ReactNode;
} & Omit<React.ComponentProps<"button">, "onClick" | "id">) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={cn("cursor-pointer", className)}
        onClick={() => setOpen(true)}
        {...props}
      >
        {children}
      </button>
      {open ? (
        <ArtifactDialog
          id={id}
          version={version}
          open={open}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
}
