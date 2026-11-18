import { useEffect } from "react";
import { placesCall } from "@/queries/places";
import { useWireState } from "@/queries/wire";
import { useWorkspaceStore } from "./workspace-store";

/**
 * The recent directories this browser kept before the host did (`workspace.recentDirectories`),
 * handed to the host once and then let go of. The host adds what it does not know behind what it
 * does, so a second try (another tab, a reload before the answer) changes nothing; only an answer
 * clears them here, so a failed try is tried again next time.
 */
export function useImportRecentDirectories(): void {
  const legacy = useWorkspaceStore(
    (state) => state.workspace.recentDirectories,
  );
  const ready = useWireState(
    (state) =>
      state.status === "open" &&
      state.mounted.some(
        (plugin) => plugin.name === "places" && plugin.error === undefined,
      ),
  );
  useEffect(() => {
    if (!ready || legacy === undefined) return;
    placesCall("importRecent", { recent: legacy }).then(
      () =>
        useWorkspaceStore
          .getState()
          .setWorkspace(({ recentDirectories: _, ...rest }) => rest),
      () => undefined,
    );
  }, [ready, legacy]);
}
