import type {
  UpgradeArgs,
  UpgradeBusy,
  UpgradePhase,
  UpgradeResults,
  UpgradeStatusView,
} from "@eta/client-contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { translate } from "@/lib/i18n";
import { getWire } from "@/lib/wire";
import { useConnectionLost, useWireMutation } from "@/queries/wire";

// The host's own version, and replacing it. The actions are the `upgrade` target's; how one is
// going is `/upgrade/status`, over plain HTTP, because the socket is gone for the part that
// matters. An address that does not answer is not an error here: it is what a restart looks like.

/** The words for a phase, under `settings:update.phase`. */
export const phaseKeys = {
  starting: "starting",
  downloading: "downloading",
  waiting: "waiting",
  stopping: "stopping",
  "backing-up": "backingUp",
  restarting: "restarting",
  verifying: "verifying",
  "rolling-back": "rollingBack",
} as const satisfies Record<UpgradePhase, string>;

/** The words for something a restart would stop, and each only once: a task may run twice over. */
export function busyLabels(busy: readonly UpgradeBusy[]): string[] {
  const labels = busy.map((item) =>
    item.kind === "task"
      ? translate("settings:update.busyTask", {
          number: item.number,
          name: item.name,
        })
      : item.kind === "routine"
        ? translate("settings:update.busyRoutine", { name: item.name })
        : translate("settings:update.busyReply", { name: item.name }),
  );
  return [...new Set(labels)];
}

const POLL_MS = 1500;
const STATUS_KEY = ["upgrade", "status"];
const CHECK_KEY = ["wire", "upgrade", "check"];

export interface UpgradeWatch {
  /** Whether the host answered. */
  reachable: boolean;
  status: UpgradeStatusView | null;
}

async function readUpgradeStatus(): Promise<UpgradeWatch> {
  try {
    const response = await fetch("/upgrade/status", { cache: "no-store" });
    // A proxy in front of a host that is down answers for it.
    if (!response.ok) return { reachable: false, status: null };
    const status = (await response
      .json()
      .catch(() => null)) as UpgradeStatusView | null;
    return { reachable: true, status };
  } catch {
    return { reachable: false, status: null };
  }
}

/**
 * Asked once, and then as long as an upgrade runs or the host does not answer. A lost connection
 * asks again, so a tab that has been told nothing still finds out.
 */
export function useUpgradeWatch(): UpgradeWatch | undefined {
  const client = useQueryClient();
  const lost = useConnectionLost();
  useEffect(() => {
    if (lost) void client.invalidateQueries({ queryKey: STATUS_KEY });
  }, [client, lost]);
  const { data } = useQuery({
    queryKey: STATUS_KEY,
    queryFn: async () => {
      const watch = await readUpgradeStatus();
      // What was known stays through a host that does not answer: it says which upgrade this is.
      const known = client.getQueryData<UpgradeWatch>(STATUS_KEY)?.status;
      return watch.reachable ? watch : { ...watch, status: known ?? null };
    },
    retry: false,
    refetchInterval: (query) => {
      const watch = query.state.data;
      return watch !== undefined &&
        (!watch.reachable || watch.status?.state === "running")
        ? POLL_MS
        : false;
    },
  });
  return data;
}

export function useUpgradeCheck() {
  return useQuery({
    queryKey: CHECK_KEY,
    queryFn: async () =>
      await getWire().call<UpgradeResults["check"]>("upgrade", "check", {}),
    staleTime: 0,
  });
}

export function useStartUpgrade() {
  const client = useQueryClient();
  return useWireMutation<UpgradeArgs["start"], UpgradeResults["start"]>(
    "upgrade",
    "start",
    {
      onSuccess: () => void client.invalidateQueries({ queryKey: STATUS_KEY }),
    },
  );
}

export function useSetUpstream() {
  const client = useQueryClient();
  return useWireMutation<
    UpgradeArgs["setUpstream"],
    UpgradeResults["setUpstream"]
  >("upgrade", "setUpstream", {
    onSuccess: () => void client.invalidateQueries({ queryKey: CHECK_KEY }),
  });
}

export function useCancelUpgrade() {
  const client = useQueryClient();
  return useWireMutation<UpgradeArgs["cancel"], UpgradeResults["cancel"]>(
    "upgrade",
    "cancel",
    {
      onSuccess: () => void client.invalidateQueries({ queryKey: STATUS_KEY }),
    },
  );
}
