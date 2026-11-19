import type {
  UpgradeArgs,
  UpgradeBusy,
  UpgradePhase,
  UpgradeResults,
  UpgradeStatusView,
} from "@eta/client-contracts";
import {
  UPGRADE_BUSY_KINDS,
  UPGRADE_PHASES,
  UPGRADE_STATES,
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
const DOWNLOAD_POLL_MS = 500;
const STATUS_KEY = ["upgrade", "status"];
const CHECK_KEY = ["wire", "upgrade", "check"];

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDownload(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value.received === "number" &&
    (value.total === undefined || typeof value.total === "number")
  );
}

function isBusy(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.kind === "string" &&
        (UPGRADE_BUSY_KINDS as readonly string[]).includes(item.kind) &&
        typeof item.name === "string",
    )
  );
}

function isUpgradeStatusView(value: unknown): value is UpgradeStatusView {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.from === "string" &&
    typeof value.state === "string" &&
    (UPGRADE_STATES as readonly string[]).includes(value.state) &&
    typeof value.phase === "string" &&
    (UPGRADE_PHASES as readonly string[]).includes(value.phase) &&
    typeof value.startedAt === "number" &&
    Array.isArray(value.log) &&
    value.log.every((line) => typeof line === "string") &&
    isOptionalString(value.to) &&
    (value.finishedAt === undefined || typeof value.finishedAt === "number") &&
    isOptionalString(value.error) &&
    isDownload(value.download) &&
    isBusy(value.busy)
  );
}

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
    const body: unknown = await response.json().catch(() => null);
    const status = isUpgradeStatusView(body) ? body : null;
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
      if (
        watch === undefined ||
        (watch.reachable && watch.status?.state !== "running")
      )
        return false;
      return watch.status?.phase === "downloading" ? DOWNLOAD_POLL_MS : POLL_MS;
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

export function useSetToken() {
  const client = useQueryClient();
  return useWireMutation<UpgradeArgs["setToken"], UpgradeResults["setToken"]>(
    "upgrade",
    "setToken",
    { onSuccess: () => void client.invalidateQueries({ queryKey: CHECK_KEY }) },
  );
}

export function useSetPrerelease() {
  const client = useQueryClient();
  return useWireMutation<
    UpgradeArgs["setPrerelease"],
    UpgradeResults["setPrerelease"]
  >("upgrade", "setPrerelease", {
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
