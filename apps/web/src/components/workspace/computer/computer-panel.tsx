import type {
  ComputerController,
  ComputerIsolationTier,
  ComputerRealmKind,
  ComputerRealmView,
  ComputerUserInput,
} from "@eta/client-contracts";
import { ArrowsOutIcon } from "@phosphor-icons/react/ArrowsOut";
import { ClipboardTextIcon } from "@phosphor-icons/react/ClipboardText";
import { XIcon } from "@phosphor-icons/react/X";
import { cn } from "cn";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useComputer,
  useComputerActions,
  useComputerRealm,
  useIsPluginMounted,
} from "@/queries/computer";
import { ComputerStrip } from "./computer-strip";
import { ComputerViewport } from "./computer-viewport";
import { formatComputerSummary } from "./format-summary";

export interface ComputerPanelProps {
  /** Target realm ID to subscribe to when expanded. */
  realmId?: string | null | undefined;
  /** Optional realm fallback from parent or `computer.realms`. */
  realm?: ComputerRealmView | null | undefined;
  /** Controlled open/expanded state. When omitted, managed internally via `defaultOpen`. */
  open?: boolean | undefined;
  /** Initial open state when uncontrolled (defaults to `false` so folded strip does not subscribe). */
  defaultOpen?: boolean | undefined;
  /** Called whenever open/expanded state changes. */
  onOpenChange?: ((open: boolean) => void) | undefined;
  /** Whether to render the compact `<ComputerStrip />` when collapsed (defaults to `true`). */
  showStripWhenCollapsed?: boolean | undefined;
  /** Optional handler to jump to the Pending/Inbox tab when a file approval is waiting. */
  onReviewApproval?: (() => void) | undefined;
  className?: string | undefined;
}

function controllerStatusKey(
  controller: ComputerController,
): "status.agent" | "status.user" | "status.paused" | "status.closed" {
  switch (controller) {
    case "user":
      return "status.user";
    case "paused":
      return "status.paused";
    case "closed":
      return "status.closed";
    default:
      return "status.agent";
  }
}

function controllerOwnerKey(
  controller: ComputerController,
): "owner.agent" | "owner.user" | "owner.released" {
  switch (controller) {
    case "user":
      return "owner.user";
    case "agent":
      return "owner.agent";
    default:
      return "owner.released";
  }
}

function realmKindKey(kind: ComputerRealmKind): "kind.browser" | "kind.app" {
  return kind === "app" ? "kind.app" : "kind.browser";
}

function realmTierKey(
  tier: ComputerIsolationTier,
):
  | "tier.cdp"
  | "tier.child_session"
  | "tier.hidden_desktop"
  | "tier.sandbox"
  | "tier.unavailable" {
  switch (tier) {
    case "child_session":
      return "tier.child_session";
    case "hidden_desktop":
      return "tier.hidden_desktop";
    case "sandbox":
      return "tier.sandbox";
    case "unavailable":
      return "tier.unavailable";
    default:
      return "tier.cdp";
  }
}

function statusDotClass(controller: ComputerRealmView["controller"]): string {
  switch (controller) {
    case "user":
      return "bg-state-warning";
    case "agent":
      return "bg-state-success animate-run-blink motion-reduce:animate-none";
    case "paused":
      return "bg-faint";
    default:
      return "bg-faint";
  }
}

/**
 * Side-panel / floating PiP container (`<ComputerPanel />`) for Computer Use realms.
 *
 * Subscribes to `computer.<realmId>` ONLY while open/expanded (unsubscribing when collapsed so
 * background frame/cursor bandwidth drops to 0). Gated by `useIsPluginMounted("computer")`.
 */
export function ComputerPanel({
  realmId: realmIdProp,
  realm: realmProp,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  showStripWhenCollapsed = true,
  onReviewApproval,
  className,
}: ComputerPanelProps) {
  const { t } = useTranslation(["computer", "common"] as const);
  const mounted = useIsPluginMounted();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const [largeOpen, setLargeOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const isExpanded = openProp ?? uncontrolledOpen;
  const setExpanded = useCallback(
    (next: boolean) => {
      if (openProp === undefined) {
        setUncontrolledOpen(next);
      }
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
  );

  const { realms } = useComputer();
  const fallbackRealm =
    realmProp ??
    (realmIdProp !== undefined && realmIdProp !== null
      ? realms.find((candidate) => candidate.id === realmIdProp)
      : realms[0]);

  const resolvedRealmId = fallbackRealm?.id ?? realmIdProp ?? undefined;

  // CRITICAL: Only subscribe to `computer.<realmId>` while open/expanded or in large dialog!
  const activeSubscriptionRealmId =
    mounted && (isExpanded || largeOpen) ? resolvedRealmId : undefined;
  const liveRealm = useComputerRealm(activeSubscriptionRealmId);
  const actions = useComputerActions(resolvedRealmId);

  const info = liveRealm.info ?? fallbackRealm;

  const handleTakeover = useCallback(() => {
    if (!resolvedRealmId) return;
    actions.takeover.mutate({ realmId: resolvedRealmId });
  }, [actions.takeover, resolvedRealmId]);

  const handleRelease = useCallback(() => {
    if (!resolvedRealmId) return;
    actions.release.mutate({ realmId: resolvedRealmId });
  }, [actions.release, resolvedRealmId]);

  const handlePauseOrResume = useCallback(() => {
    if (!resolvedRealmId || !info) return;
    if (info.controller === "paused") {
      actions.resume.mutate({ realmId: resolvedRealmId });
    } else {
      actions.pause.mutate({ realmId: resolvedRealmId });
    }
  }, [actions.pause, actions.resume, info, resolvedRealmId]);

  const handleClose = useCallback(() => {
    if (!resolvedRealmId) return;
    // An app realm is showing a real program with real, possibly unsaved work: ending it is the
    // user's decision, so it goes through one explicit question. A browser realm has nothing to lose.
    if (info?.kind === "app") {
      setConfirmClose(true);
      return;
    }
    setLargeOpen(false);
    actions.close.mutate({ realmId: resolvedRealmId });
  }, [actions.close, info, resolvedRealmId]);

  const handleConfirmClose = useCallback(() => {
    if (!resolvedRealmId) return;
    setConfirmClose(false);
    setLargeOpen(false);
    actions.close.mutate({ realmId: resolvedRealmId, endApp: true });
  }, [actions.close, resolvedRealmId]);

  const handlePromote = useCallback(() => {
    if (!resolvedRealmId) return;
    actions.promote.mutate({ realmId: resolvedRealmId });
  }, [actions.promote, resolvedRealmId]);

  const handleDemote = useCallback(() => {
    if (!resolvedRealmId) return;
    actions.demote.mutate({ realmId: resolvedRealmId });
  }, [actions.demote, resolvedRealmId]);

  const handleUserInput = useCallback(
    (input: ComputerUserInput) => {
      if (!resolvedRealmId || info?.controller !== "user") return;
      actions.sendInput(input);
    },
    [actions, info?.controller, resolvedRealmId],
  );

  // Explicit one-shot paste from the user's host clipboard into the realm while in takeover mode.
  const handlePasteFromHost = useCallback(() => {
    if (!resolvedRealmId || info?.controller !== "user") return;
    const readText = globalThis.navigator?.clipboard?.readText;
    if (typeof readText !== "function") {
      toast.info(t("action.pasteEmpty"));
      return;
    }
    void readText
      .call(globalThis.navigator.clipboard)
      .then((text) => {
        if (text === "") {
          toast.info(t("action.pasteEmpty"));
          return;
        }
        actions.sendInput({ kind: "type", text });
        toast.success(t("action.pasteSent", { count: text.length }));
      })
      .catch(() => {
        toast.info(t("action.pasteEmpty"));
      });
  }, [actions, info?.controller, resolvedRealmId, t]);

  const handleResolvePicker = useCallback(
    (files?: string[]) => {
      if (!resolvedRealmId) return;
      actions.resolvePicker.mutate({
        realmId: resolvedRealmId,
        files: files ?? [],
      });
    },
    [actions.resolvePicker, resolvedRealmId],
  );

  if (!mounted) {
    return null;
  }

  // The realm was closed (its `computer.<id>` target is gone): draw nothing rather than a panel
  // showing the last frame it will ever have.
  if (liveRealm.missing === true) {
    return null;
  }

  if (!isExpanded) {
    if (!showStripWhenCollapsed) {
      return null;
    }
    return (
      <ComputerStrip
        realm={info}
        realmId={resolvedRealmId}
        expanded={false}
        onToggleExpand={setExpanded}
        onTakeover={handleTakeover}
        onRelease={handleRelease}
        className={className}
      />
    );
  }

  if (!info) {
    return (
      <section
        data-slot="computer-panel"
        data-state="empty"
        aria-label={t("title")}
        className={cn(
          "flex flex-col rounded-none border border-border bg-surface text-xs text-foreground",
          className,
        )}
      >
        <header className="flex h-8 items-center justify-between border-b border-border px-2.5">
          <span className="font-medium">{t("title")}</span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            data-slot="computer-panel-collapse"
            onClick={() => setExpanded(false)}
          >
            {t("action.collapse")}
          </Button>
        </header>
        <div
          data-slot="computer-panel-empty"
          className="flex min-h-36 flex-col items-center justify-center gap-1 p-4 text-center text-muted-foreground"
        >
          <p className="font-medium text-foreground">
            {liveRealm.missing ? t("empty.offline") : t("empty.title")}
          </p>
          <p className="text-[11px]">{t("empty.description")}</p>
        </div>
      </section>
    );
  }

  const {
    controller,
    kind,
    tier,
    title,
    target,
    summary,
    viewport,
    agentName,
  } = info;
  const isUser = controller === "user";
  const isPaused = controller === "paused";
  const isClosed = controller === "closed";
  const promoted = info.promoted === true;
  /** A browser realm has no OS window to show, and a closed realm has no screen to take. */
  const canPromote =
    !isClosed && typeof tier === "string" && tier.includes("hidden");
  const displaySummary = formatComputerSummary(summary, t);

  const controls = !isClosed ? (
    <div
      data-slot="computer-panel-controls"
      className="flex shrink-0 items-center gap-1"
    >
      {isUser ? (
        <>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            data-slot="computer-action-paste"
            title={t("action.pasteHostHint")}
            onClick={handlePasteFromHost}
          >
            <ClipboardTextIcon aria-hidden="true" className="size-3.5" />
            <span>{t("action.pasteHost")}</span>
          </Button>
          <Button
            type="button"
            size="xs"
            variant="default"
            data-slot="computer-action-release"
            disabled={actions.release.isPending}
            onClick={handleRelease}
          >
            {t("action.release")}
          </Button>
        </>
      ) : (
        <Button
          type="button"
          size="xs"
          variant="outline"
          data-slot="computer-action-takeover"
          disabled={actions.takeover.isPending}
          onClick={handleTakeover}
        >
          {t("action.takeover")}
        </Button>
      )}

      <Button
        type="button"
        size="xs"
        variant="ghost"
        data-slot={
          isPaused ? "computer-action-resume" : "computer-action-pause"
        }
        disabled={actions.pause.isPending || actions.resume.isPending}
        onClick={handlePauseOrResume}
      >
        {isPaused ? t("action.resume") : t("action.pause")}
      </Button>

      {/* Only a hidden-desktop app realm has a screen to take; browsers stay headless. */}
      {canPromote &&
        (promoted ? (
          <Button
            type="button"
            size="xs"
            variant="default"
            data-slot="computer-action-demote"
            disabled={actions.demote.isPending}
            onClick={handleDemote}
          >
            {t("action.demote")}
          </Button>
        ) : (
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-slot="computer-action-promote"
            title={t("action.promoteHint")}
            disabled={actions.promote.isPending}
            onClick={handlePromote}
          >
            {t("action.promote")}
          </Button>
        ))}
    </div>
  ) : null;

  // Closed realms collapse into a single compact history bar instead of occupying a dead 300px box.
  if (isClosed) {
    return (
      <section
        data-slot="computer-panel"
        data-realm-id={info.id}
        data-controller={controller}
        aria-label={title || t("title")}
        className={cn(
          "flex h-8 items-center justify-between gap-2 rounded-none border border-border bg-surface/60 px-2.5 text-xs text-muted-foreground",
          className,
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            data-slot="computer-panel-dot"
            aria-hidden="true"
            className="size-1.5 shrink-0 rounded-none bg-faint"
          />
          <span
            data-slot="computer-panel-kind"
            className="shrink-0 font-mono text-[10px] tracking-[0.06em] uppercase"
          >
            {t(realmKindKey(kind))}
          </span>
          <span
            data-slot="computer-panel-title"
            className="min-w-0 truncate font-medium text-foreground/70"
            title={title}
          >
            {title}
          </span>
          <span className="min-w-0 truncate font-mono text-[11px]">
            ·{" "}
            {displaySummary ||
              (kind === "app"
                ? t("action.closedAppRunning")
                : t("hint.closedSummary"))}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge
            data-slot="computer-panel-status"
            variant="secondary"
            className="font-mono text-[10px]"
          >
            {t(controllerStatusKey(controller))}
          </Badge>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            data-slot="computer-panel-collapse"
            onClick={() => setExpanded(false)}
          >
            {t("action.collapse")}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <>
      <section
        data-slot="computer-panel"
        data-realm-id={info.id}
        data-controller={controller}
        aria-label={title || t("title")}
        className={cn(
          "flex flex-col rounded-none border bg-surface text-xs text-foreground transition-colors duration-[60ms] ease-linear motion-reduce:transition-none",
          isUser ? "border-state-warning" : "border-border",
          className,
        )}
      >
        {/* Header: status indicator, title, tier badge, large view, close, collapse */}
        <header
          data-slot="computer-panel-header"
          className="flex h-8 items-center justify-between gap-2 border-b border-border bg-surface px-2.5"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span
              data-slot="computer-panel-dot"
              aria-hidden="true"
              className={cn(
                "size-1.5 shrink-0 rounded-none",
                statusDotClass(controller),
              )}
            />
            <span
              data-slot="computer-panel-kind"
              className="shrink-0 font-mono text-[10px] tracking-[0.06em] text-muted-foreground uppercase"
            >
              {t(realmKindKey(kind))}
            </span>
            <span
              data-slot="computer-panel-title"
              className="min-w-0 truncate font-medium text-foreground"
              title={title}
            >
              {title}
            </span>
            {target !== "" && (
              <span
                data-slot="computer-panel-target"
                className="hidden sm:inline min-w-0 truncate font-mono text-[11px] text-muted-foreground"
                title={target}
              >
                {target}
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Badge
              data-slot="computer-panel-tier"
              variant="outline"
              className="font-mono text-[10px] text-muted-foreground"
            >
              {t(realmTierKey(tier))}
            </Badge>
            <Badge
              data-slot="computer-panel-status"
              variant={isUser ? "default" : "secondary"}
              className="font-mono text-[10px]"
            >
              {t(controllerStatusKey(controller))}
            </Badge>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              data-slot="computer-action-large"
              title={t("action.largeView")}
              aria-label={t("action.largeView")}
              onClick={() => setLargeOpen(true)}
            >
              <ArrowsOutIcon aria-hidden="true" className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              data-slot="computer-panel-collapse"
              onClick={() => setExpanded(false)}
            >
              {t("action.collapse")}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              data-slot="computer-action-close"
              title={t("action.close")}
              aria-label={t("action.close")}
              disabled={actions.close.isPending}
              className="text-muted-foreground hover:text-state-error"
              onClick={handleClose}
            >
              <XIcon aria-hidden="true" className="size-3.5" />
            </Button>
          </div>
        </header>

        {/* Clean frame + vector cursor + interactive takeover surface */}
        <div className="p-2">
          <ComputerViewport
            frame={liveRealm.frame}
            viewport={viewport}
            controller={controller}
            cursor={liveRealm.cursor}
            agentName={agentName}
            picker={liveRealm.picker}
            title={title}
            onUserInput={handleUserInput}
            onResolvePicker={handleResolvePicker}
            onReviewApproval={onReviewApproval}
            onPasteFromHost={handlePasteFromHost}
          />
        </div>

        {/* Single-writer control toolbar & bottom summary bar */}
        <footer
          data-slot="computer-panel-footer"
          className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-background px-2.5 py-1.5"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 truncate">
            <span
              data-slot="computer-panel-owner"
              className="shrink-0 font-mono text-[11px] text-muted-foreground"
            >
              {t(controllerOwnerKey(controller))}
            </span>
            {displaySummary !== "" && (
              <span
                data-slot="computer-panel-summary"
                className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground"
                title={summary}
              >
                · {displaySummary}
              </span>
            )}
          </div>

          {controls}
        </footer>
      </section>

      {/* Large-screen view dialog for precision takeover without losing the conversation */}
      <Dialog open={largeOpen} onOpenChange={setLargeOpen}>
        <DialogContent
          data-slot="computer-large-dialog"
          className="flex h-[calc(100dvh-2rem)] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[calc(100dvh-4rem)] sm:max-w-[min(90rem,calc(100%-4rem))]"
        >
          <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface px-3 pr-11 text-xs">
            <div className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 shrink-0 rounded-none",
                  statusDotClass(controller),
                )}
              />
              <DialogTitle className="truncate text-xs font-medium">
                {title || t("title")}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {target || t("title")}
              </DialogDescription>
              {target !== "" && (
                <span className="hidden truncate font-mono text-[11px] text-muted-foreground sm:inline">
                  {target}
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Badge
                variant="outline"
                className="font-mono text-[10px] text-muted-foreground"
              >
                {t(realmTierKey(tier))}
              </Badge>
              <Badge
                variant={isUser ? "default" : "secondary"}
                className="font-mono text-[10px]"
              >
                {t(controllerStatusKey(controller))}
              </Badge>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 items-center justify-center bg-background p-3">
            <ComputerViewport
              frame={liveRealm.frame}
              viewport={viewport}
              controller={controller}
              cursor={liveRealm.cursor}
              agentName={agentName}
              picker={liveRealm.picker}
              title={title}
              onUserInput={handleUserInput}
              onResolvePicker={handleResolvePicker}
              onReviewApproval={onReviewApproval}
              onPasteFromHost={handlePasteFromHost}
              className="max-h-full max-w-full"
            />
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border bg-surface px-3 py-2 text-xs">
            <div className="flex min-w-0 flex-1 items-center gap-2 truncate">
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {t(controllerOwnerKey(controller))}
              </span>
              {displaySummary !== "" && (
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                  · {displaySummary}
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {controls}
              <Button
                type="button"
                size="xs"
                variant="destructive"
                disabled={actions.close.isPending}
                onClick={handleClose}
              >
                {t("action.close")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Ending an app realm is the user's decision, and it destroys unsaved work: ask first. */}
      <Dialog open={confirmClose} onOpenChange={setConfirmClose}>
        <DialogContent
          data-slot="computer-close-confirm"
          className="max-w-md rounded-none"
        >
          <DialogTitle className="text-sm font-medium">
            {t("action.close")}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {t("action.closeAppConfirm", { target: target || t("title") })}
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              data-slot="computer-close-cancel"
              onClick={() => setConfirmClose(false)}
            >
              {t("action.cancel")}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="destructive"
              data-slot="computer-close-confirm-end"
              disabled={actions.close.isPending}
              onClick={handleConfirmClose}
            >
              {t("action.endApp")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
