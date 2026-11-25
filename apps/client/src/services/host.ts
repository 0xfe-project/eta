import type {
  AgentView,
  ArtifactView,
  BoardTaskView,
  CaptainIdentitySection,
  ConversationSummary,
  InteractionView,
  ProjectView,
  UpgradeCheckView,
} from "@eta/client-contracts";
import type {
  WireEvent,
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
import {
  logProblem,
  problemDetail,
  problemHasDetail,
  problemText,
} from "./problem-text";
import { createUpgradeWatch } from "./upgrade-watch";

export interface HostAddress {
  origin: string;
  token?: string;
  local?: boolean;
}

/** How long a change shown ahead of the host stays after the host took it, for its copy to land. */
const optimisticHold = 2000;

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
  /** The last failed action in the user's words, and as it came (for Details and the console). */
  const error = signal("");
  const errorDetail = signal("");
  const address = signal<HostAddress | null>(null);
  const hasConnected = signal(false);
  /** This run has been online at least once: the workspace, once shown, is not thrown away. */
  const everConnected = signal(false);
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
        if (paused() && at) start(at, { keepWorkspace: true });
        else wire?.wake();
      });
    active = now;
  });

  /**
   * Opens the wire to `next`, or closes it. `keepWorkspace` is for the app waking up and
   * reconnecting by itself: the user did not ask for anything, so what they had open stays on
   * screen. Every other call starts over at the connection page.
   */
  function start(
    next: HostAddress | null,
    options: { keepWorkspace?: boolean } = {},
  ) {
    wire?.close();
    wire = undefined;
    if (!options.keepWorkspace) everConnected.set(false);
    address.set(next);
    state.set(initialWireState());
    error.set("");
    errorDetail.set("");
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
          everConnected.set(true);
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

  /**
   * What the screen shows ahead of the host (#380): fields of a row (a task, a conversation) by
   * its id, set the moment a change is made and dropped once the host's own copy says the same,
   * or when the change failed (`optimistic`).
   */
  const ahead = signal<Record<string, Record<string, unknown>>>({});

  function withAhead(value: unknown): unknown {
    const rows = ahead();
    if (!Object.keys(rows).length || !value || typeof value !== "object")
      return value;
    const patch = (item: unknown) => {
      const id = (item as { id?: unknown } | null)?.id;
      const fields = typeof id === "string" ? rows[id] : undefined;
      return fields ? { ...(item as object), ...fields } : item;
    };
    if (!Array.isArray(value)) return patch(value);
    return value.some((item) => patch(item) !== item)
      ? value.map(patch)
      : value;
  }

  function section<T>(target: string, key: string): T | undefined {
    return withAhead(state().targets[target]?.sections[key]) as T | undefined;
  }

  /** Each change ahead of the host by row, so an older one's answer does not undo a newer one. */
  let aheadTurn = 0;
  const aheadTurns = new Map<string, number>();
  function dropAhead(id: string, turn: number) {
    if (aheadTurns.get(id) !== turn) return;
    aheadTurns.delete(id);
    ahead.update((rows) => {
      const { [id]: _, ...rest } = rows;
      return rest;
    });
  }

  /**
   * Shows `fields` on the row `id` everywhere at once, then does `work`: on success the row keeps
   * them until the host's copy has them (it usually sends it before it answers), on failure they
   * go and the error is the caller's to say where the change was made. Rows only: what the change
   * started on the host (a run, a notice) comes from the host as before.
   */
  async function optimistic<T>(
    id: string,
    fields: Record<string, unknown>,
    work: () => Promise<T>,
  ): Promise<T> {
    const turn = ++aheadTurn;
    aheadTurns.set(id, turn);
    ahead.update((rows) => ({ ...rows, [id]: { ...rows[id], ...fields } }));
    try {
      const result = await work();
      // The host's copy is in by now, or is a moment away.
      setTimeout(dropAhead, optimisticHold, id, turn);
      return result;
    } catch (problem) {
      dropAhead(id, turn);
      throw problem;
    }
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
    errorDetail.set("");
    try {
      return await work();
    } catch (problem) {
      logProblem(problem);
      error.set(problemText(problem));
      errorDetail.set(problemHasDetail(problem) ? problemDetail(problem) : "");
      return undefined;
    }
  }

  async function checkUpgrade() {
    const activeWire = wire;
    const result = await call<UpgradeCheckView>("upgrade", "check", {});
    if (wire === activeWire) upgradeCheck.set(result);
  }

  /**
   * Captain's conversation as a list row would show it. It is not a row of `conversations.list`
   * (the sidebar keeps Captain apart), so it comes with Captain's identity.
   */
  const captainConversation = () =>
    section<CaptainIdentitySection>("captain", "identity")?.conversation ??
    undefined;
  return {
    address,
    state,
    disconnected,
    error,
    errorDetail,
    failures,
    paused,
    lastOnline,
    hasConnected,
    everConnected,
    start,
    subscriptionWire,
    section,
    list,
    call,
    onEvent: (target: string, listener: (event: WireEvent) => void) =>
      wire?.onEvent(target, listener) ?? (() => {}),
    action,
    optimistic,
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
    /** Reconnect now if the connection is down, else check the one that looks open. */
    wake: () => wire?.wake(),
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
    captainConversation,
    /** A conversation's row by id: a group from the list, or Captain's own. */
    conversation: (id: string | null | undefined) =>
      id
        ? (list<ConversationSummary>("conversations").find(
            (item) => item.id === id,
          ) ??
          (captainConversation()?.id === id
            ? captainConversation()
            : undefined))
        : undefined,
    /** The tasks, less one archived ahead of the host (`optimistic`), as the host will send them. */
    tasks: () =>
      list<BoardTaskView>("tasks").filter(
        (task) => !(task.archivedAt && ahead()[task.id]?.archivedAt),
      ),
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

/** How many conversations read lately stay followed after their page leaves them (#380). */
const keptConversations = 4;
/** Per connection, the conversations left lately: the release of each, oldest first. */
const keptReleases = new WeakMap<Wire, Map<string, () => void>>();
const conversationTarget = /^conversations\.[^.]+$/;

/**
 * Lets go of a target. A conversation's messages are kept a while instead (still followed, so
 * still current): going back to one shows them at once rather than its skeleton, and only the
 * `keptConversations` left last are kept.
 */
function release(
  wire: Wire | undefined,
  name: string | undefined,
  unsubscribe: () => void,
) {
  if (!wire || !name || !conversationTarget.test(name)) {
    unsubscribe();
    return;
  }
  let kept = keptReleases.get(wire);
  if (!kept) keptReleases.set(wire, (kept = new Map()));
  kept.get(name)?.();
  kept.delete(name);
  kept.set(name, unsubscribe);
  for (const [oldest, drop] of kept) {
    if (kept.size <= keptConversations) break;
    kept.delete(oldest);
    drop();
  }
}

/** Follows `name` again, taking back a kept hold on it (`release`) once the new one is in place. */
function resubscribe(wire: Wire, name: string) {
  const unsubscribe = wire.subscribe(name);
  const kept = keptReleases.get(wire);
  const held = kept?.get(name);
  if (held) {
    kept!.delete(name);
    held();
  }
  return unsubscribe;
}

export function follow(target: () => string | undefined) {
  const host = useHost();
  let currentName: string | undefined;
  let currentWire: Wire | undefined;
  let unsubscribe: (() => void) | undefined;
  cleanup(() => {
    if (unsubscribe) release(currentWire, currentName, unsubscribe);
  });
  effect(() => {
    const name = target();
    const wire = host.subscriptionWire();
    // A selector can read the whole host snapshot. Patches for the same target
    // must keep its subscription and its in-flight data intact.
    if (name === currentName && wire === currentWire) return;
    if (unsubscribe) release(currentWire, currentName, unsubscribe);
    currentName = name;
    currentWire = wire;
    unsubscribe = name && wire ? resubscribe(wire, name) : undefined;
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
