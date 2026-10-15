import { ArrowClockwiseIcon } from "@phosphor-icons/react/ArrowClockwise";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** Refresh mounted page queries without replacing the page or its local state. */
export function RefreshButton({
  resource,
}: {
  resource: "tasks" | "routines";
}) {
  const { t: translateText } = useTranslation("common");
  const client = useQueryClient();
  const fetching = useIsFetching({ queryKey: [resource], type: "active" });
  const lockedRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const busy = refreshing || fetching > 0;
  const refresh = async () => {
    if (lockedRef.current || busy) return;
    lockedRef.current = true;
    setRefreshing(true);
    try {
      await client.refetchQueries(
        { queryKey: [resource], type: "active" },
        { cancelRefetch: false, throwOnError: true },
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translateText("errors.refreshFailed"),
      );
    } finally {
      lockedRef.current = false;
      setRefreshing(false);
    }
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={translateText("actions.refresh")}
      aria-busy={busy}
      title={
        busy
          ? translateText("states.refreshing")
          : translateText("actions.refresh")
      }
      disabled={busy}
      onClick={() => void refresh()}
    >
      <ArrowClockwiseIcon
        aria-hidden="true"
        className={busy ? "motion-safe:animate-spin" : undefined}
      />
    </Button>
  );
}
