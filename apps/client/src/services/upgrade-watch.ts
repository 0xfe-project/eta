import type { UpgradeStatusView } from "@eta/client-contracts";
import type { HostAddress } from "./host";
import { signal, Storage, untracked } from "nsh";

const activeInterval = 600;
const idleInterval = 20_000;
// The worker can wait two minutes for the new service, then two more for rollback, so a Host away
// for five minutes is not normal: the restart screen says so then and offers another host. The
// upgrade is only given up on (and the app goes back to reconnecting as usual) well after that.
const restartWindow = 30 * 60_000;
const phases = [
  "starting",
  "downloading",
  "waiting",
  "stopping",
  "backing-up",
  "restarting",
  "verifying",
  "rolling-back",
];
const states = [
  "running",
  "done",
  "failed",
  "rolled-back",
  "broken",
  "cancelled",
  "lost",
];

function isUpgradeStatus(value: unknown): value is UpgradeStatusView {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<UpgradeStatusView>;
  return (
    typeof state.id === "string" &&
    typeof state.from === "string" &&
    (state.to === undefined || typeof state.to === "string") &&
    typeof state.startedAt === "number" &&
    states.includes(state.state ?? "") &&
    phases.includes(state.phase ?? "") &&
    Array.isArray(state.log)
  );
}

// Browsers send the Host's same-origin session cookie. Native pairings use the
// same bearer as their socket, and a redirect must not carry that credential away.
async function readUpgradeStatus(
  address: HostAddress,
  signal: AbortSignal,
): Promise<{ status: UpgradeStatusView | null } | "unavailable" | "unknown"> {
  try {
    const response = await fetch(new URL("/upgrade/status", address.origin), {
      cache: "no-store",
      credentials: "same-origin",
      headers: address.token
        ? { Authorization: `Bearer ${address.token}` }
        : undefined,
      redirect: "error",
      signal,
    });
    if (!response.ok) return response.status >= 500 ? "unavailable" : "unknown";
    if (!response.headers.get("content-type")?.includes("application/json"))
      return "unknown";
    const status: unknown = await response.json();
    return status === null || isUpgradeStatus(status) ? { status } : "unknown";
  } catch {
    return "unavailable";
  }
}

interface UpgradeHint {
  status: UpgradeStatusView;
  seenAt: number;
}

interface Probe {
  address: HostAddress;
  key?: string;
  request?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  rerun: boolean;
  answered: boolean;
  supported: boolean;
  seenAt: number;
  savedAt: number;
}

function storageKey(address: HostAddress): string | undefined {
  const key = `eta.upgrade-restart:${address.origin}`;
  if (!address.token) return key;
  try {
    const fingerprint = crypto
      .createHash("sha256")
      .update(address.token)
      .digest("hex");
    return `${key}:${fingerprint}`;
  } catch {
    // Persistence is optional on an engine without a native hash implementation.
    return undefined;
  }
}

export function createUpgradeWatch() {
  const status = signal<UpgradeStatusView>();
  const unreachable = signal(false);
  let current: Probe | undefined;

  function forget(probe: Probe) {
    if (probe.key) void Storage.removeItem(probe.key).catch(() => {});
    probe.savedAt = 0;
  }

  async function restore(probe: Probe) {
    if (!probe.key) return;
    try {
      const saved = await Storage.getItem(probe.key);
      if (!saved || current !== probe || probe.answered) return;
      const hint = JSON.parse(saved) as UpgradeHint;
      if (
        !isUpgradeStatus(hint.status) ||
        hint.status.state !== "running" ||
        !Number.isFinite(hint.seenAt) ||
        hint.seenAt > Date.now() ||
        Date.now() - hint.seenAt >= restartWindow
      ) {
        forget(probe);
        return;
      }
      probe.seenAt = hint.seenAt;
      probe.savedAt = hint.seenAt;
      status.set(hint.status);
      refresh();
    } catch {
      // A bad or unavailable preference must not interfere with connecting.
    }
  }

  function remember(
    probe: Probe,
    next: UpgradeStatusView,
    previous?: UpgradeStatusView,
  ) {
    if (!probe.key) return;
    if (
      next.id === previous?.id &&
      next.phase === previous.phase &&
      Date.now() - probe.savedAt < idleInterval
    )
      return;
    // Persist only the identifying phase and versions, never logs or credentials.
    const { id, state, phase, from, to, startedAt } = next;
    const hint: UpgradeHint = {
      status: { id, state, phase, from, to, startedAt, log: [] },
      seenAt: probe.seenAt,
    };
    probe.savedAt = probe.seenAt;
    void Storage.setItem(probe.key, JSON.stringify(hint)).catch(() => {});
  }

  async function read(probe: Probe) {
    const request = new AbortController();
    probe.request = request;
    const timeout = setTimeout(() => request.abort(), 3500);
    const reply = await readUpgradeStatus(probe.address, request.signal);
    clearTimeout(timeout);
    if (current !== probe) return;
    probe.request = undefined;
    unreachable.set(reply === "unavailable");
    const previous = untracked(status);
    if (reply === "unavailable") {
      if (
        previous?.state === "running" &&
        Date.now() - probe.seenAt >= restartWindow
      ) {
        status.set(undefined);
        forget(probe);
      }
    } else {
      probe.answered = true;
      if (reply === "unknown") {
        probe.supported = false;
        status.set(undefined);
        forget(probe);
      } else {
        probe.supported = true;
        probe.seenAt = Date.now();
        status.set(reply.status ?? undefined);
        if (reply.status?.state === "running")
          remember(probe, reply.status, previous);
        else if (probe.savedAt || !previous) forget(probe);
      }
    }
    if (probe.rerun) {
      probe.rerun = false;
      refresh();
    } else if (untracked(status)?.state === "running") {
      probe.timer = setTimeout(refresh, activeInterval);
    } else if (probe.supported) {
      probe.timer = setTimeout(refresh, idleInterval);
    }
  }

  function refresh() {
    if (!current) return;
    clearTimeout(current.timer);
    if (current.request) {
      current.rerun = true;
    } else {
      void read(current);
    }
  }

  function start(address: HostAddress | null) {
    if (
      address &&
      current?.address.origin === address.origin &&
      current.address.token === address.token
    )
      return;
    current?.request?.abort();
    clearTimeout(current?.timer);
    current = address
      ? {
          address,
          key: storageKey(address),
          rerun: false,
          answered: false,
          supported: false,
          seenAt: 0,
          savedAt: 0,
        }
      : undefined;
    status.set(undefined);
    unreachable.set(false);
    if (current) {
      void restore(current);
      refresh();
    }
  }

  return { status, unreachable, start, refresh };
}
