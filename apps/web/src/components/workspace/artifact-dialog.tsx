import type { ArtifactVersion } from "@/queries/artifacts";
import { AppWindowIcon } from "@phosphor-icons/react/AppWindow";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { DownloadSimpleIcon } from "@phosphor-icons/react/DownloadSimple";
import { GlobeIcon } from "@phosphor-icons/react/Globe";
import { PrinterIcon } from "@phosphor-icons/react/Printer";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Empty, LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  useArtifacts,
  usePreview,
  useShareArtifact,
  useUnshareArtifact,
} from "@/queries/artifacts";
import { wireErrorMessage } from "@/queries/wire";
import { Select, SelectOption } from "./select-field";

/**
 * An artifact's page in a dialog: large on a desktop, nearly the whole
 * screen on a phone. The site runs in a sandboxed frame (an opaque origin:
 * no cookies, storage or eta API), loaded from a preview address the host
 * hands out for the version; it works without cookies for an hour, and the
 * same policy holds when it is opened in a new window.
 */
const SANDBOX =
  "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

/** What this app knows how to show in its frame. A version of anything else is its ZIP. */
const FRAMED_KINDS = new Set(["site"]);

const opensInFrame = (version: ArtifactVersion): boolean =>
  version.viewer === "iframe" && FRAMED_KINDS.has(version.kind);

/**
 * The host ends every page it previews with a listener for this message, and the page prints
 * itself as it is now: the frame is an opaque origin, so its `print()` is out of the app's reach.
 */
const PRINT_MESSAGE = { type: "eta:print" } as const;

/** A phone or tablet: printing from a frame there is hit and miss, so the button is not offered. */
const printsUnreliably = (): boolean =>
  typeof matchMedia === "function" &&
  matchMedia("(hover: none) and (pointer: coarse)").matches;

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
  const { t: translateText } = useTranslation(["artifacts", "common"] as const);
  const { artifacts, loaded, error } = useArtifacts();
  const artifact = artifacts.find((item) => item.id === id);
  const [chosen, setChosen] = useState<number | undefined>(version);
  const versions = artifact?.versions ?? [];
  const current =
    versions.find((v) => v.number === chosen) ?? versions.at(0) ?? null;
  // The address the frame loads from carries a capability that works for an hour, so it is asked
  // for each time a version is shown and kept nowhere but here.
  const { mutate: ask, data: preview, error: previewError } = usePreview();
  const framed = current !== null && opensInFrame(current);
  const shown = framed ? current.number : undefined;
  useEffect(() => {
    if (open && shown !== undefined) ask({ artifactId: id, version: shown });
  }, [open, id, shown, ask]);
  const failed = error ?? (framed ? previewError : null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [printable] = useState(() => !printsUnreliably());
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[calc(100dvh-1rem)] max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:h-[calc(100dvh-4rem)] sm:max-w-[min(96rem,calc(100%-4rem))]">
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2 pr-11">
          <AppWindowIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          <DialogTitle className="min-w-0 flex-1 truncate">
            {artifact?.title ?? "Artifact"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {translateText("sandboxDescription")}
          </DialogDescription>
          {current && artifact ? (
            <div className="flex w-full items-center gap-1 sm:w-auto">
              {versions.length > 1 ? (
                <Select
                  aria-label={translateText("version.title")}
                  value={String(current.number)}
                  onValueChange={(value) => setChosen(Number(value))}
                  size="sm"
                  className="tabular-nums"
                >
                  {versions.map((v) => (
                    <SelectOption key={v.number} value={v.number}>
                      {translateText("version.option", {
                        version: v.number,
                        latestLabel:
                          v.number === versions[0].number
                            ? translateText("version.latestSuffix")
                            : "",
                      })}
                    </SelectOption>
                  ))}
                </Select>
              ) : (
                <span className="px-1 text-xs text-muted-foreground tabular-nums">
                  {translateText("version.label", {
                    version: current.number,
                  })}
                </span>
              )}
              <span className="flex-1 sm:hidden" />
              <ShareControl id={id} version={current} />
              {framed && printable ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={preview === undefined}
                  title={translateText("print.hint")}
                  onClick={() =>
                    frameRef.current?.contentWindow?.postMessage(
                      PRINT_MESSAGE,
                      "*",
                    )
                  }
                >
                  <PrinterIcon aria-hidden="true" />
                  <span className="max-sm:sr-only">
                    {translateText("print.action")}
                  </span>
                </Button>
              ) : null}
              {framed ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={preview === undefined}
                  asChild
                >
                  <a
                    href={preview?.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ArrowSquareOutIcon aria-hidden="true" />
                    <span className="max-sm:sr-only">
                      {translateText("common:actions.openInNewWindow")}
                    </span>
                  </a>
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" asChild>
                <a href={current.archiveUrl} download>
                  <DownloadSimpleIcon aria-hidden="true" />
                  <span className="max-sm:sr-only">
                    {translateText("common:actions.download")}
                  </span>
                </a>
              </Button>
            </div>
          ) : null}
        </div>
        {current?.shareUrl ? <ShareLink url={current.shareUrl} /> : null}
        <div className={cn("relative min-h-0 flex-1", framed && "bg-white")}>
          {failed ? (
            <LoadError
              what={translateText("loadTarget")}
              error={failed}
              onRetry={
                current
                  ? () => ask({ artifactId: id, version: current.number })
                  : undefined
              }
            />
          ) : !loaded || (framed && preview === undefined) ? (
            <Loading
              layout="detail"
              className="p-6"
              label={translateText("common:states.opening")}
            />
          ) : current && !framed ? (
            <Empty
              icon={DownloadSimpleIcon}
              title={translateText("downloadOnly.title")}
              action={
                <Button variant="outline" size="sm" asChild>
                  <a href={current.archiveUrl} download>
                    {translateText("common:actions.download")}
                  </a>
                </Button>
              }
            >
              {translateText("downloadOnly.description")}
            </Empty>
          ) : current && preview && artifact ? (
            <iframe
              ref={frameRef}
              key={`${current.number}:${preview.url}`}
              title={artifact.title}
              src={preview.url}
              sandbox={SANDBOX}
              referrerPolicy="no-referrer"
              className="absolute inset-0 size-full border-0"
            />
          ) : (
            <Empty icon={AppWindowIcon} title={translateText("gone")} />
          )}
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
  const { t: translateText } = useTranslation(["artifacts", "common"] as const);
  const share = useShareArtifact();
  const unshare = useUnshareArtifact();
  const shared = version.shareUrl !== null;
  const call = { artifactId: id, version: version.number };
  const onError = (error: Error) => toast.error(wireErrorMessage(error));
  return (
    <Button
      variant={shared ? "secondary" : "ghost"}
      size="sm"
      disabled={share.isPending || unshare.isPending}
      title={
        shared
          ? translateText("sharing.revokeHint")
          : translateText("sharing.createHint")
      }
      onClick={() =>
        shared
          ? unshare.mutate(call, {
              onSuccess: () => toast(translateText("sharing.revoked")),
              onError,
            })
          : share.mutate(call, {
              onSuccess: () => toast(translateText("sharing.created")),
              onError,
            })
      }
    >
      <GlobeIcon aria-hidden="true" />
      <span className="max-sm:sr-only">
        {shared
          ? translateText("sharing.revoke")
          : translateText("sharing.sharePublicly")}
      </span>
    </Button>
  );
}

function ShareLink({ url }: { url: string }) {
  const { t: translateText } = useTranslation(["artifacts", "common"] as const);
  const link = new URL(url, window.location.origin).href;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs">
      <span className="shrink-0 text-muted-foreground">
        {translateText("sharing.publicLink")}
      </span>
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
            .then(() => toast(translateText("common:feedback.linkCopied")))
            .catch(() =>
              toast.error(translateText("common:errors.clipboardBlocked")),
            )
        }
      >
        <CopyIcon aria-hidden="true" />
        {translateText("common:actions.copy")}
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
