import { cn } from "cn";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useComputer, useIsPluginMounted } from "@/queries/computer";
import { ComputerPanel } from "./computer-panel";

/**
 * Pinned bar above the chat composer showing active (non-closed) Computer Use realms.
 *
 * Solves the "buried in folded Thinking process" problem: even after a turn collapses or the user
 * scrolls down several turns, any running background realm stays one click away without auto-
 * expanding and jittering the layout.
 *
 * Realms belonging to another conversation are listed too (after the current conversation's ones):
 * their apps keep running across page reloads, host restarts and conversation switches, so hiding
 * them would leave the user with no way back to a screen that is still live.
 */
export function ActiveRealmsBar({
  conversationId,
  onReviewApproval,
  className,
}: {
  conversationId: string | undefined;
  onReviewApproval?: (() => void) | undefined;
  className?: string | undefined;
}) {
  const { t } = useTranslation(["computer"] as const);
  const mounted = useIsPluginMounted();
  const { realms } = useComputer();
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);

  if (!mounted) {
    return null;
  }

  const visibleRealms = realms.filter((realm) => realm.controller !== "closed");
  const activeRealms = [
    ...visibleRealms.filter((realm) => realm.conversationId === conversationId),
    ...visibleRealms.filter((realm) => realm.conversationId !== conversationId),
  ];
  if (activeRealms.length === 0) {
    return null;
  }

  const current =
    activeRealms.find((realm) => realm.id === selectedId) ?? activeRealms[0]!;
  const hasOtherConversations = activeRealms.some(
    (realm) => realm.conversationId !== conversationId,
  );

  return (
    <div
      data-slot="active-realms-bar"
      className={cn("flex flex-col gap-1", className)}
    >
      {(activeRealms.length > 1 || hasOtherConversations) && (
        <div
          data-slot="active-realms-tabs"
          className="flex items-center gap-1 overflow-x-auto text-[11px]"
        >
          <span className="shrink-0 font-mono text-[10px] tracking-[0.06em] text-muted-foreground uppercase">
            {t("hint.activeRealms")} ({activeRealms.length})
          </span>
          {activeRealms.map((realm) => {
            const active = realm.id === current.id;
            const other = realm.conversationId !== conversationId;
            return (
              <button
                key={realm.id}
                type="button"
                data-slot="active-realm-tab"
                data-active={active ? "true" : "false"}
                data-other-conversation={other ? "true" : undefined}
                title={other ? t("hint.otherConversation") : undefined}
                onClick={() => setSelectedId(realm.id)}
                className={cn(
                  "shrink-0 rounded-none border px-1.5 py-0.5 font-mono text-[10px] transition-colors duration-[60ms] ease-linear motion-reduce:transition-none",
                  active
                    ? "border-foreground bg-surface text-foreground"
                    : "border-border bg-background text-muted-foreground hover:text-foreground",
                  other && !active && "border-dashed",
                )}
              >
                {realm.title || realm.target}
              </button>
            );
          })}
        </div>
      )}
      <ComputerPanel
        realmId={current.id}
        realm={current}
        open={expanded}
        onOpenChange={setExpanded}
        onReviewApproval={onReviewApproval}
      />
    </div>
  );
}
