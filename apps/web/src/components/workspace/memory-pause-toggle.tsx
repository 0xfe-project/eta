import { ProhibitIcon } from "@phosphor-icons/react/Prohibit";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useCaptain, useCaptainActions } from "@/queries/captain";
import { useTarget } from "@/queries/wire";

/**
 * The persistent memory switch for one conversation or task. It is a checkbox where there is
 * room for a word, and an icon button in the chat header where there is not; both send the same
 * Captain action and read the same published pause row.
 */
export function MemoryPauseToggle({
  scopeType,
  scopeId,
  compact = false,
}: {
  scopeType: "conversation" | "task";
  scopeId: string;
  compact?: boolean;
}) {
  const { t } = useTranslation("captain");
  const mounted = useTarget("captain") !== undefined;
  const captain = useCaptain();
  const actions = useCaptainActions();
  if (!mounted) return null;
  const paused = captain.memoryPauses.some(
    (item) =>
      item.scopeType === scopeType && item.scopeId === scopeId && item.paused,
  );
  const label = t(paused ? "memoryPause.resume" : "memoryPause.pause");
  const toggle = () =>
    void actions.setMemoryPaused.mutateAsync({
      scopeType,
      scopeId,
      paused: !paused,
    });

  if (compact)
    return (
      <Button
        size="icon"
        variant="ghost"
        className={paused ? "text-muted-foreground" : undefined}
        aria-label={label}
        title={label}
        aria-pressed={paused}
        onClick={toggle}
      >
        <ProhibitIcon aria-hidden="true" />
      </Button>
    );

  return (
    <label className="flex min-w-0 items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={paused}
        onChange={toggle}
        aria-label={label}
        className="size-4 accent-foreground"
      />
      <span className="truncate">{t("memoryPause.label")}</span>
      {paused ? (
        <span className="text-xs text-muted-foreground">
          {t("memoryPause.paused")}
        </span>
      ) : null}
    </label>
  );
}
