import type {
  ComputerController,
  ComputerRealmKind,
  ComputerRealmView,
} from "@eta/client-contracts";
import { cn } from "cn";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  useComputer,
  useComputerActions,
  useIsPluginMounted,
} from "@/queries/computer";
import { formatComputerSummary } from "./format-summary";

export interface ComputerStripProps {
  /** Realm summary object (when already available in parent) or resolved via `realmId` from root `computer`. */
  realm?: ComputerRealmView | null | undefined;
  /** Realm ID to look up from `computer.realms` and target for quick actions. */
  realmId?: string | undefined;
  /** Whether the full `<ComputerPanel />` view for this realm is currently expanded. */
  expanded?: boolean | undefined;
  /** Toggle handler for expanding or collapsing the full `<ComputerPanel />`. */
  onToggleExpand?: ((expanded: boolean) => void) | undefined;
  /** Optional override for takeover action. */
  onTakeover?: (() => void) | undefined;
  /** Optional override for release action. */
  onRelease?: (() => void) | undefined;
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

function statusDotClass(controller: ComputerController): string {
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
 * Compact folded status bar (`<ComputerStrip />`) for chat turns and task logs.
 *
 * Follows `ToolCard` & `DESIGN.md` dashboard compactness: starts and stays a single compact
 * folded row, never auto-expanding to jitter the layout, and never subscribing to the heavy
 * `computer.<realmId>` frame stream on its own.
 */
export function ComputerStrip({
  realm: realmProp,
  realmId,
  expanded = false,
  onToggleExpand,
  onTakeover,
  onRelease,
  className,
}: ComputerStripProps) {
  const { t } = useTranslation(["computer", "common"] as const);
  const mounted = useIsPluginMounted();
  const { realms } = useComputer();

  const resolvedRealm =
    realmProp ??
    (realmId !== undefined
      ? realms.find((candidate) => candidate.id === realmId)
      : realms[0]);

  const effectiveRealmId = resolvedRealm?.id ?? realmId;
  const actions = useComputerActions(effectiveRealmId);

  const handleToggleController = useCallback(() => {
    if (!resolvedRealm || resolvedRealm.controller === "closed") return;
    if (resolvedRealm.controller === "user") {
      if (onRelease) {
        onRelease();
      } else {
        actions.release.mutate(
          effectiveRealmId !== undefined
            ? { realmId: effectiveRealmId }
            : undefined,
        );
      }
    } else {
      if (onTakeover) {
        onTakeover();
      } else {
        actions.takeover.mutate(
          effectiveRealmId !== undefined
            ? { realmId: effectiveRealmId }
            : undefined,
        );
      }
    }
  }, [resolvedRealm, onRelease, onTakeover, actions, effectiveRealmId]);

  if (!mounted || !resolvedRealm) {
    return null;
  }

  const { controller, kind, title, target, summary } = resolvedRealm;
  const isClosed = controller === "closed";
  const isUser = controller === "user";
  const displaySummary = formatComputerSummary(summary, t);

  return (
    <div
      data-slot="computer-strip"
      data-realm-id={resolvedRealm.id}
      data-controller={controller}
      data-expanded={expanded ? "true" : "false"}
      className={cn(
        "flex min-h-8 w-full items-center justify-between gap-2 overflow-hidden rounded-none border border-border bg-background px-2.5 py-1 text-xs text-foreground transition-colors duration-[60ms] ease-linear motion-reduce:transition-none",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <span
          data-slot="computer-strip-dot"
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-none",
            statusDotClass(controller),
          )}
        />
        <span
          data-slot="computer-strip-kind"
          className="shrink-0 font-mono text-[10px] tracking-[0.06em] text-muted-foreground uppercase"
        >
          {t(realmKindKey(kind))}
        </span>
        <span
          data-slot="computer-strip-title"
          className="min-w-0 truncate font-medium text-foreground"
          title={title}
        >
          {title}
        </span>
        {target !== "" && (
          <span
            data-slot="computer-strip-target"
            className="hidden min-w-0 max-w-40 truncate font-mono text-[11px] text-muted-foreground lg:inline"
            title={target}
          >
            {target}
          </span>
        )}
        {displaySummary !== "" && (
          <span
            data-slot="computer-strip-summary"
            className="hidden min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground xl:inline"
            title={summary}
          >
            · {displaySummary}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <Badge
          data-slot="computer-strip-badge"
          variant={isUser ? "default" : "outline"}
          title={t(controllerOwnerKey(controller))}
          className="font-mono text-[10px]"
        >
          {t(controllerStatusKey(controller))}
        </Badge>

        {!isClosed && (
          <Button
            type="button"
            size="xs"
            variant={isUser ? "secondary" : "outline"}
            data-slot="computer-strip-takeover"
            disabled={actions.takeover.isPending || actions.release.isPending}
            onClick={handleToggleController}
          >
            {isUser ? t("action.release") : t("action.takeover")}
          </Button>
        )}

        {onToggleExpand !== undefined && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            data-slot="computer-strip-expand"
            aria-expanded={expanded}
            onClick={() => onToggleExpand(!expanded)}
          >
            {expanded ? t("action.collapse") : t("action.expand")}
          </Button>
        )}
      </div>
    </div>
  );
}
