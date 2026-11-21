import type {
  AgentView,
  ArtifactView,
  BoardTaskView,
  ConversationSummary,
  InteractionView,
  ProjectView,
  UpgradeCheckView,
} from "@eta/client-contracts";
import type {
  WireSocket,
  WireSocketEvents,
  WireState,
} from "@eta/client-contracts/wire";
import type { WebSocketConnection } from "websocket";
import {
  fromWebSocket,
  initialWireState,
  Wire,
} from "@eta/client-contracts/wire";
import {
  appInfo,
  cleanup,
  context,
  effect,
  lifecycle,
  platform,
  signal,
  untracked,
  UrlScheme,
} from "nsh";
import { connect } from "websocket";
import { formatLocale } from "../i18n";
import { createUpgradeWatch } from "./upgrade-watch";

export interface HostAddress {
  origin: string;
  token?: string;
  local?: boolean;
}

export function addressFrom(value: string): string {
  const trimmed = value.trim();
  const withScheme = trimmed.includes("://") ? trimmed : `http://${trimmed}`;
  const url = new URL(withScheme);
  if (
    !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("Enter an HTTP or HTTPS host address.");
  }
  if (url.pathname !== "/" && url.pathname !== "/ws") {
    throw new Error("Use the host address without a page path.");
  }
  return url.origin.replace(/^ws/, "http");
}

export function defaultAddress(): HostAddress | null {
  if (platform.os !== "web") {
    if (!appInfo().development) return null;
    // NSH exposes environment metadata on the VM global.
    // eslint-disable-next-line node/prefer-global/process
    const devHost = globalThis.process?.env?.ETA_HOST_ORIGIN;
    if (!devHost) return null;
    try {
      return { origin: addressFrom(devHost) };
    } catch {
      return null;
    }
  }
  const address = UrlScheme.url();
  if (!address) return null;
  const url = new URL(address);
  const host = url.searchParams.get("host");
  try {
    return { origin: host ? addressFrom(host) : url.origin };
  } catch {
    return { origin: url.origin };
  }
}

function openSocket(
  address: HostAddress,
  events: WireSocketEvents,
): WireSocket {
  const url = `${address.origin.replace(/^http/, "ws")}/ws`;
  if (platform.os === "web" || !address.token) {
    const socket = new WebSocket(url);
    return fromWebSocket(
      {
        addEventListener: (type, listener) =>
          socket.addEventListener(type, (event) =>
            listener(event as typeof event & { data?: unknown }),
          ),
        send: (text) => socket.send(text),
        close: () => socket.close(),
      },
      events,
    );
  }

  let socket: WebSocketConnection | undefined;
  let closed = false;
  let writes: Promise<void> = Promise.resolve();
  function lost() {
    if (closed) return;
    closed = true;
    void socket?.close().catch(() => {});
    events.close();
  }
  void connect(url, { headers: { Authorization: `Bearer ${address.token}` } })
    .then(async (started) => {
      if (closed) {
        await started.close();
        return;
      }
      socket = started;
      events.open();
      for (;;) {
        const frame = await started.read();
        if (closed || frame === null) break;
        if (typeof frame === "string") events.message(frame);
      }
      lost();
    })
    .catch(lost);
  return {
    send(text) {
      const current = socket;
      if (!current || closed) throw new Error("Not connected.");
      // The native connection bounds outstanding commands. Keep the bursts of
      // initial subscriptions in order with only one native write in flight.
      writes = writes
        .then(() => {
          if (!closed) return current.write(text);
        })
        .catch(lost);
    },
    close: lost,
  };
}

/**
 * How long the connection may be away before the app says so. Most drops (a phone switching
 * networks, a host restarting) are over sooner, and a notice that flashes for them is noise.
 */
const RECONNECT_GRACE_MS = 2_000;

export interface HostOptions {
  /** How a socket to `address` is opened; a test supplies its own. */
  openSocket?: (address: HostAddress, events: WireSocketEvents) => WireSocket;
}

export function createHost(options: HostOptions = {}) {
  const open = options.openSocket ?? openSocket;
  const state = signal<WireState>(initialWireState());
  const error = signal("");
  const address = signal<HostAddress | null>(null);
  const hasConnected = signal(false);
  const failures = signal(0);
  const paused = signal(false);
  const lastOnline = signal<number | null>(null);
  const upgrades = createUpgradeWatch();
  const upgradeCheck = signal<UpgradeCheckView>();
  let wire: Wire | undefined;
  const subscriptionWire = signal<Wire | undefined>(undefined);

  // `reconnecting` that has lasted the grace period: what the app shows as disconnected.
  const disconnected = signal(false);
  let grace: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    if (state().status !== "reconnecting") {
      clearTimeout(grace);
      grace = undefined;
      disconnected.set(false);
      return;
    }
    // Every failed attempt sets the status again: the period runs from the first.
    if (grace !== undefined || untracked(disconnected)) return;
    grace = setTimeout(() => {
      grace = undefined;
      disconnected.set(true);
    }, RECONNECT_GRACE_MS);
  });
  cleanup(() => clearTimeout(grace));

  // Back in the foreground (the system may have cut the connection meanwhile, and the retries
  // have slowed to their longest pause, or given up): reconnect now, or check the one that looks
  // open.
  let active = untracked(lifecycle) === "active";
  effect(() => {
    const now = lifecycle() === "active";
    if (now && !active)
      untracked(() => {
        const at = address();
        if (paused() && at) start(at);
        else wire?.wake();
      });
    active = now;
  });

  function start(next: HostAddress | null) {
    wire?.close();
    wire = undefined;
    address.set(next);
    state.set(initialWireState());
    error.set("");
    failures.set(0);
    paused.set(false);
    hasConnected.set(false);
    upgradeCheck.set(undefined);
    upgrades.start(next);
    if (!next) {
      subscriptionWire.set(undefined);
      return;
    }
    wire = new Wire({
      open: (events) => open(next, events),
      store: {
        getState: () => untracked(state),
        setState: (update) =>
          state.update((previous) => ({
            ...previous,
            ...(typeof update === "function" ? update(previous) : update),
          })),
      },
      observer: {
        hello: () => {
          lastOnline.set(Date.now());
          hasConnected.set(true);
          failures.set(0);
          if (untracked(state).ops.includes("upgrade.check"))
            upgrades.refresh();
        },
        dropped: upgrades.refresh,
        attemptFailed: () => {
          const count = untracked(failures) + 1;
          if (count === 1 && untracked(hasConnected))
            lastOnline.set(Date.now());
          failures.set(count);
          if (
            count >= 5 &&
            untracked(hasConnected) &&
            untracked(upgrades.status)?.state !== "running"
          ) {
            wire?.close();
            paused.set(true);
          }
        },
      },
    });
    wire.connect();
    subscriptionWire.set(wire);
  }

  function section<T>(target: string, key: string): T | undefined {
    return state().targets[target]?.sections[key] as T | undefined;
  }

  function list<T>(target: string, key = "list"): T[] {
    return section<T[]>(target, key) ?? [];
  }

  async function call<T>(
    target: string,
    action: string,
    args?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    if (!wire) throw new Error("Connect to an Eta host first.");
    return wire.call<T>(target, action, args, options);
  }

  async function action<T>(work: () => Promise<T>): Promise<T | undefined> {
    error.set("");
    try {
      return await work();
    } catch (problem) {
      error.set(problem instanceof Error ? problem.message : String(problem));
      return undefined;
    }
  }

  async function checkUpgrade() {
    const activeWire = wire;
    const result = await call<UpgradeCheckView>("upgrade", "check", {});
    if (wire === activeWire) upgradeCheck.set(result);
  }

  return {
    address,
    state,
    disconnected,
    error,
    failures,
    paused,
    lastOnline,
    hasConnected,
    start,
    subscriptionWire,
    section,
    list,
    call,
    action,
    upgrade: upgrades.status,
    upgradeUnreachable: upgrades.unreachable,
    upgradeCheck,
    checkUpgrade,
    watchUpgrade: upgrades.start,
    refreshUpgrade: upgrades.refresh,
    retry: () => {
      if (address()) start(address());
    },
    reconnect: () => wire?.retryNow(),
    can: (op: string) => state().ops.includes(op),
    agents: () => list<AgentView>("agents"),
    people: () =>
      list<AgentView>("agents").filter((agent) => !agent.systemRole),
    captain: () =>
      list<AgentView>("agents").find((agent) => agent.systemRole === "captain"),
    agent: (id: string | null | undefined) =>
      list<AgentView>("agents").find((agent) => agent.id === id),
    projects: () => list<ProjectView>("projects"),
    conversations: () => list<ConversationSummary>("conversations"),
    tasks: () => list<BoardTaskView>("tasks"),
    pending: () =>
      list<InteractionView>("inbox").filter(
        (item) => item.status === "pending",
      ),
    artifacts: () => list<ArtifactView>("artifacts"),
  };
}

export const Host = context<ReturnType<typeof createHost> | undefined>(
  undefined,
);
export function useHost() {
  const host = Host();
  if (!host) throw new Error("The Eta host context is missing.");
  return host;
}

export function follow(target: () => string | undefined) {
  const host = useHost();
  let currentName: string | undefined;
  let currentWire: Wire | undefined;
  let unsubscribe: (() => void) | undefined;
  cleanup(() => unsubscribe?.());
  effect(() => {
    const name = target();
    const wire = host.subscriptionWire();
    // A selector can read the whole host snapshot. Patches for the same target
    // must keep its subscription and its in-flight data intact.
    if (name === currentName && wire === currentWire) return;
    currentName = name;
    currentWire = wire;
    unsubscribe?.();
    unsubscribe = name ? wire?.subscribe(name) : undefined;
  });
  return () => {
    unsubscribe?.();
    unsubscribe = currentName ? currentWire?.subscribe(currentName) : undefined;
  };
}

/** Sessions a host has been asked to open, per host. */
const openedSessions = new WeakMap<object, Set<string>>();

/**
 * Follow a session's view (`sessions.<id>`). A session the host has not opened since it started
 * (a member not woken since a restart) is not a target yet and answers `target:missing`, so it is
 * opened first with `sessions.resync`, which is cheap for one already open, as the web app does.
 */
export function followSession(session: () => string | undefined) {
  const host = useHost();
  const opened = openedSessions.get(host) ?? new Set<string>();
  openedSessions.set(host, opened);
  const ready = signal<string | undefined>(undefined);
  effect(() => {
    const id = session();
    if (!id || opened.has(id)) {
      ready.set(id);
      return;
    }
    void host
      .call("sessions", "resync", { session: id })
      .then(
        () => opened.add(id),
        () => {},
      )
      .finally(() => {
        if (untracked(session) === id) ready.set(id);
      });
  });
  follow(() => {
    const id = ready();
    return id ? `sessions.${id}` : undefined;
  });
}

export function clock(at: number) {
  return new Date(at).toLocaleTimeString(formatLocale(), {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function relativeTime(at: number) {
  const locale = formatLocale();
  const minutes = Math.floor(Math.abs(Date.now() - at) / 60_000);
  const chinese = locale === "zh-CN";
  if (minutes < 1) return chinese ? "刚刚" : "now";
  if (minutes < 60) return `${minutes}${chinese ? " 分钟" : "m"}`;
  if (minutes < 1440)
    return `${Math.floor(minutes / 60)}${chinese ? " 小时" : "h"}`;
  return new Date(at).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
  });
}
