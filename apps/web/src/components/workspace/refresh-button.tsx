import { ArrowClockwiseIcon } from "@phosphor-icons/react/ArrowClockwise";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** Refresh mounted page queries without replacing the page or its local state. */
export function RefreshButton({
  resource,
}: {
  resource: "tasks" | "routines";
}) {
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
      toast.error(error instanceof Error ? error.message : "刷新失败");
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
      aria-label="刷新"
      aria-busy={busy}
      title={busy ? "刷新中…" : "刷新"}
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
