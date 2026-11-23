import type {
  ComputerCursorEvent,
  ComputerFrameEvent,
  ComputerMachineCapabilities,
  ComputerMicroAction,
  ComputerPickerEvent,
  ComputerPickerState,
  ComputerRealmView,
  ComputerUserInput,
  ViewportSize,
} from "@eta/client-contracts";
import type { EventFrame, ServerFrame } from "@eta/client-wire-proto";
import type { RealmDriver } from "@eta/computer";
import type { Socket } from "@eta/server";
import type { MachineHub, MachineLink } from "../src/machines/hub";
/**
 * Daemon Link and Remote Computer Realm Mirror (`T8`):
 *
 * - Warm-on-subscribe: 0 frame events cross the link while no client is subscribed to
 *   `computer.<realmId>`; subscribing warms the daemon realm (`setWatched(true)`) and delivers
 *   `frame` / `cursor` / `picker` events; unsubscribing cools it back to 0 frame traffic.
 * - Reconnect deduplication: after link loss and recovery, replayed events with `at <= lastAt`
 *   are filtered out while newer events pass through.
 * - Oversize frames exceeding `LINK_LIMITS.maxFrameBytes` (8 MiB) are guarded so they never
 *   close the link with 1009.
 * - Action forwarding (`takeover`, `release`, `pause`, `resume`, `stop`, `input`, `resolvePicker`,
 *   `close`) reaches the daemon's `RealmManager`.
 */
import { LINK_CLOSE, LINK_LIMITS } from "@eta/client-contracts";
import { RealmManager } from "@eta/computer";
import { createConnection, WireService } from "@eta/server";
import { describe, expect, it } from "vitest";
import {
  isComputerFrameWithinBudget,
  mountDaemonComputer,
} from "../../daemon/src/computer";
import { Peer } from "../../daemon/src/link/peer";
import {
  ComputerRealmMirrors,
  isWithinFrameBudget,
} from "../src/computer/mirror";

interface PipeListener {
  state: (frame: {
    snapshot?: import("@eta/client-wire-proto").StateSnapshot;
    patch?: import("@eta/client-wire-proto").StatePatch;
  }) => void;
  event: (name: string, data: unknown, at: number | undefined) => void;
}

class TestPipeClient {
  readonly #peer: Peer;
  readonly #pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  readonly #listeners = new Map<string, PipeListener>();
  readonly ready: Promise<void>;
  #markReady!: () => void;
  #dead = false;
  #next = 0;

  constructor(peer: Peer) {
    this.#peer = peer;
    this.ready = new Promise<void>((resolve) => {
      this.#markReady = resolve;
    });
  }

  receive(frame: unknown): void {
    const server = frame as ServerFrame;
    switch (server.type) {
      case "hello":
        this.#markReady();
        return;
      case "reply": {
        const pending = this.#pending.get(server.requestId);
        if (pending === undefined) return;
        this.#pending.delete(server.requestId);
        if (server.ok) pending.resolve(server.result);
        else pending.reject(new Error(server.error));
        return;
      }
      case "state": {
        const listener = this.#listeners.get(server.target);
        listener?.state({
          ...(server.snapshot === undefined
            ? {}
            : { snapshot: server.snapshot }),
          ...(server.patch === undefined ? {} : { patch: server.patch }),
        });
        return;
      }
      case "event":
        this.#listeners
          .get(server.target)
          ?.event(server.name, server.data, server.at);
        break;
      default:
    }
  }

  call(target: string, action: string, args: unknown): Promise<unknown> {
    if (this.#dead) {
      return Promise.reject(new Error(`${target}.${action}: link is down`));
    }
    const requestId = `p${++this.#next}`;
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      this.#peer.sendPipe({
        op: "call",
        target,
        action,
        ...(args === undefined ? {} : { args }),
        requestId,
      });
    });
  }

  subscribe(target: string, listener: PipeListener): void {
    this.#listeners.set(target, listener);
    this.#peer.sendPipe({ op: "subscribe", target });
  }

  unsubscribe(target: string): void {
    if (this.#listeners.delete(target) && !this.#dead) {
      this.#peer.sendPipe({ op: "unsubscribe", target });
    }
  }

  subscribed(target: string): boolean {
    return this.#listeners.has(target);
  }

  lost(reason: string): void {
    if (this.#dead) return;
    this.#dead = true;
    for (const [id, pending] of [...this.#pending]) {
      this.#pending.delete(id);
      pending.reject(new Error(`link lost: ${reason}`));
    }
    this.#listeners.clear();
  }
}

interface FakeRealmHarness {
  driver: RealmDriver;
  watchedTransitions: boolean[];
  executedActions: ComputerMicroAction[];
  executedUserInputs: ComputerUserInput[];
  resolvedPickers: string[][];
  closedCount: () => number;
}

function createFakeRealmDriver(
  viewport: ViewportSize = { width: 1280, height: 720 },
): FakeRealmHarness {
  const watchedTransitions: boolean[] = [];
  const executedActions: ComputerMicroAction[] = [];
  const executedUserInputs: ComputerUserInput[] = [];
  const resolvedPickers: string[][] = [];
  let closed = 0;

  const driver: RealmDriver = {
    kind: "browser",
    tier: "cdp",
    title: () => "Remote Browser Realm",
    target: () => "https://remote.example.test",
    viewport: () => viewport,
    observe: async () => ({
      mimeType: "image/jpeg",
      data: "Y2xlYW4tZnJhbWUtZGF0YQ==",
      viewport,
    }),
    step: async (action) => {
      executedActions.push(action);
      return { summary: `Step ${action.kind}` };
    },
    userInput: async (input) => {
      executedUserInputs.push(input);
    },
    resolvePicker: async (files) => {
      resolvedPickers.push([...files]);
      return {
        status: "intercepted_silent",
        files: [...files],
        updatedAt: Date.now(),
      };
    },
    setWatched: (watched) => {
      watchedTransitions.push(watched);
    },
    close: async () => {
      closed += 1;
    },
  };

  return {
    driver,
    watchedTransitions,
    executedActions,
    executedUserInputs,
    resolvedPickers,
    closedCount: () => closed,
  };
}

/**
 * In-memory duplex link harness wiring a Daemon `WireService` (mounted with `mountDaemonComputer`)
 * to a Primary `WireService` (mounted with `ComputerRealmMirrors`) over the real `Peer` and
 * `PipeClient` link envelope (`LINK_LIMITS.maxFrameBytes`).
 */
interface LinkedComputerHarness {
  machineId: string;
  daemonWire: WireService;
  primaryWire: WireService;
  daemonManager: RealmManager;
  mirrors: ComputerRealmMirrors;
  /** Raw JSON link envelopes sent from daemon -> primary. */
  daemonToPrimaryTraffic: string[];
  /** Raw JSON link envelopes sent from primary -> daemon. */
  primaryToDaemonTraffic: string[];
  /** Browser frames delivered to a given primary socketId. */
  browserFramesOf: (socketId: number) => ServerFrame[];
  /** Browser event payloads delivered to a given primary socketId for (target, eventName). */
  browserEventsOf: <T>(
    socketId: number,
    target: string,
    eventName: string,
  ) => T[];
  /** Browser call against primary `WireService`. */
  callPrimary: <T = unknown>(
    target: string,
    action: string,
    args?: Record<string, unknown>,
  ) => Promise<T>;
  /** Count link envelopes carrying a `frame` event for `computer.<realmId>`. */
  countLinkFrames: (realmId: string) => number;
  /** Simulate link loss (`hub.onLost` + socket close on daemon). */
  dropLink: (reason?: string) => void;
  /** Simulate link reconnect (`hub.onReady` with a fresh `Peer` + `PipeClient`). */
  reconnectLink: () => Promise<void>;
  /** Whether any side closed the link with a close code (e.g., 1009 tooBig). */
  closeCodes: { side: "primary" | "daemon"; code: number; reason: string }[];
  /** Flush queued pipe frames across the in-memory link. */
  flushLink: () => Promise<void>;
  dispose: () => void;
}

async function createLinkedComputerHarness(
  options: {
    machineId?: string;
    capabilities?: ComputerMachineCapabilities;
    daemonMaxFrameBytes?: number;
    mirrorMaxFrameBytes?: number;
  } = {},
): Promise<LinkedComputerHarness> {
  const machineId = options.machineId ?? "machine_win_daemon";
  const createStubContext = () =>
    ({
      reflect: { provide: () => {} },
      set: () => {},
      runtime: {},
      effect: () => {},
    }) as never;

  const daemonWire = new WireService(createStubContext(), {
    focusedIntervalMs: 0,
    backgroundIntervalMs: 0,
  });
  const primaryWire = new WireService(createStubContext(), {
    focusedIntervalMs: 0,
    backgroundIntervalMs: 0,
  });

  const daemonManager = new RealmManager({ machineId });
  const unmountDaemonComputer = mountDaemonComputer(daemonWire, daemonManager, {
    capabilities: options.capabilities ?? {
      machineId,
      os: "win32",
      edition: "Professional",
      browser: "ready",
      windowsChildSession: "ready",
      windowsHiddenDesktop: "ready",
    },
    ...(options.daemonMaxFrameBytes === undefined
      ? {}
      : { maxFrameBytes: options.daemonMaxFrameBytes }),
  });

  const browserFramesBySocket = new Map<number, ServerFrame[]>();
  primaryWire.attachSink((addressed) => {
    if (addressed.socketId !== undefined) {
      const list = browserFramesBySocket.get(addressed.socketId) ?? [];
      list.push(addressed.frame);
      browserFramesBySocket.set(addressed.socketId, list);
      return;
    }
    if (addressed.target !== undefined) {
      for (const watcher of primaryWire.state.watchersOf(addressed.target)) {
        const list = browserFramesBySocket.get(watcher.socketId) ?? [];
        list.push(addressed.frame);
        browserFramesBySocket.set(watcher.socketId, list);
      }
    }
  });

  const readyListeners = new Set<(link: MachineLink) => void>();
  const lostListeners = new Set<(id: string, reason: string) => void>();
  let activeLink: MachineLink | undefined;
  let activeDaemonConnection:
    | { socketId: number; close: () => void }
    | undefined;
  let epochCounter = 0;
  let daemonSocketCounter = 0;

  const daemonToPrimaryTraffic: string[] = [];
  const primaryToDaemonTraffic: string[] = [];
  const closeCodes: {
    side: "primary" | "daemon";
    code: number;
    reason: string;
  }[] = [];

  let currentDaemonSend: ((frame: ServerFrame) => void) | undefined;

  daemonWire.attachSink((addressed) => {
    if (activeDaemonConnection === undefined) return;
    const currentSocketId = activeDaemonConnection.socketId;
    if (addressed.socketId !== undefined) {
      if (addressed.socketId === currentSocketId) {
        currentDaemonSend?.(addressed.frame);
      }
      return;
    }
    if (
      addressed.target === undefined ||
      daemonWire.state.subscriptions(currentSocketId).includes(addressed.target)
    ) {
      currentDaemonSend?.(addressed.frame);
    }
  });

  const fakeHub = {
    link: (id: string): MachineLink | undefined =>
      id === machineId ? activeLink : undefined,
    onReady: (listener: (link: MachineLink) => void): (() => void) => {
      readyListeners.add(listener);
      return () => {
        readyListeners.delete(listener);
      };
    },
    onLost: (listener: (id: string, reason: string) => void): (() => void) => {
      lostListeners.add(listener);
      return () => {
        lostListeners.delete(listener);
      };
    },
  } as unknown as MachineHub;

  const mirrors = new ComputerRealmMirrors(fakeHub, {
    ...(options.mirrorMaxFrameBytes === undefined
      ? {}
      : { maxFrameBytes: options.mirrorMaxFrameBytes }),
  });
  mirrors.attach(primaryWire);

  const connectPeers = async (): Promise<void> => {
    const epoch = ++epochCounter;
    let primaryPipe!: TestPipeClient;
    let daemonPeer!: Peer;

    const primaryPeer = new Peer({
      send: (text) => {
        primaryToDaemonTraffic.push(text);
        daemonPeer.receive(text);
      },
      close: (code, reason) => {
        closeCodes.push({ side: "primary", code, reason });
      },
      onPipe: (frame) => {
        primaryPipe.receive(frame);
      },
    });
    primaryPipe = new TestPipeClient(primaryPeer);

    const socketId = ++daemonSocketCounter;
    let daemonConn!: ReturnType<typeof createConnection>;
    daemonPeer = new Peer({
      send: (text) => {
        daemonToPrimaryTraffic.push(text);
        primaryPeer.receive(text);
      },
      close: (code, reason) => {
        closeCodes.push({ side: "daemon", code, reason });
      },
      onPipe: (frame) => {
        void daemonConn.handle(JSON.stringify(frame));
      },
    });

    const daemonSocket: Socket = {
      id: socketId,
      send: (frame: ServerFrame) => {
        daemonPeer.sendPipe(frame);
      },
    };
    currentDaemonSend = (frame: ServerFrame) => daemonConn.send(frame);
    daemonConn = createConnection(daemonSocket, {
      wire: daemonWire,
      mounted: () => [],
    });

    activeDaemonConnection = {
      socketId,
      close: () => {
        daemonConn.close();
        daemonPeer.markLost("link dropped");
      },
    };

    await primaryPipe.ready;
    const link: MachineLink = {
      machineId,
      epoch,
      peer: primaryPeer,
      pipe: primaryPipe as never,
      machine: (action, args) =>
        primaryPipe.call("machine", action, args) as never,
      daemon: (method, params, opts) =>
        primaryPeer.call(method, params, opts) as never,
    };
    activeLink = link;
    for (const listener of readyListeners) {
      listener(link);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  const dropLink = (reason = "connection reset"): void => {
    const current = activeLink;
    if (current === undefined) return;
    activeLink = undefined;
    currentDaemonSend = undefined;
    activeDaemonConnection?.close();
    activeDaemonConnection = undefined;
    current.peer.markLost(reason);
    current.pipe.lost(reason);
    for (const listener of lostListeners) {
      listener(machineId, reason);
    }
  };

  await connectPeers();

  const flushLink = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  let callSeq = 0;
  const callPrimary = async <T = unknown>(
    target: string,
    action: string,
    args?: Record<string, unknown>,
  ): Promise<T> => {
    const outcome = await primaryWire.dispatch(
      {
        op: "call",
        target,
        action,
        requestId: `req_${++callSeq}`,
        ...(args === undefined ? {} : { args }),
      },
      { reply: () => {} },
    );
    return outcome.result as T;
  };

  return {
    machineId,
    daemonWire,
    primaryWire,
    daemonManager,
    mirrors,
    daemonToPrimaryTraffic,
    primaryToDaemonTraffic,
    browserFramesOf: (socketId) => browserFramesBySocket.get(socketId) ?? [],
    browserEventsOf: <T>(
      socketId: number,
      target: string,
      eventName: string,
    ): T[] =>
      (browserFramesBySocket.get(socketId) ?? [])
        .filter(
          (f): f is EventFrame =>
            f.type === "event" && f.target === target && f.name === eventName,
        )
        .map((f) => f.data as T),
    callPrimary,
    countLinkFrames: (realmId: string): number => {
      const targetMatch = `"target":"computer.${realmId}"`;
      return daemonToPrimaryTraffic.filter(
        (raw) =>
          raw.includes('"type":"event"') &&
          raw.includes('"name":"frame"') &&
          raw.includes(targetMatch),
      ).length;
    },
    dropLink,
    reconnectLink: connectPeers,
    closeCodes,
    flushLink,
    dispose: () => {
      dropLink("disposed");
      mirrors.detach();
      unmountDaemonComputer();
    },
  };
}

describe("computerRealmMirrors & mountDaemonComputer (T8)", () => {
  it("enforces warm-on-subscribe: 0 frame traffic across the link while unwatched, warms on subscribe, and cools to 0 on unsubscribe", async () => {
    const h = await createLinkedComputerHarness();
    const driverHarness = createFakeRealmDriver();
    const realm = h.daemonManager.register(driverHarness.driver, {
      id: "realm_warm_1",
      machineId: h.machineId,
      sessionId: "sess_1",
    });

    const target = `computer.${realm.id}`;

    // The daemon's `computer` target automatically registers the remote realm on the primary mirror.
    expect(h.mirrors.owns(realm.id)).toBe(true);
    expect(h.mirrors.get(realm.id)?.warm).toBe(false);
    expect(realm.isWatched).toBe(false);
    expect(driverHarness.watchedTransitions).toEqual([]);

    // Observing and executing actions while no browser client is subscribed produces 0 link frames.
    await realm.observe();
    await realm.act([{ kind: "move", x: 150, y: 250 }]);
    expect(h.countLinkFrames(realm.id)).toBe(0);

    // Browser client #1 (socketId = 101) subscribes to `computer.<realmId>` on the primary.
    const browserSocketId = 101;
    h.primaryWire.subscribe(browserSocketId, target);
    await h.flushLink();

    // Subscribing warms the mirror and the daemon's ManagedRealm (`setWatched(true)`).
    expect(h.mirrors.get(realm.id)?.warm).toBe(true);
    expect(realm.isWatched).toBe(true);
    expect(driverHarness.watchedTransitions).toEqual([true]);

    // Emitting a frame and cursor event on the daemon now crosses the link and reaches the browser.
    realm.emitFrame({
      mimeType: "image/jpeg",
      data: "ZnJhbWUtMQ==",
      viewport: { width: 1280, height: 720 },
      at: 1_000,
    });
    await realm.act([{ kind: "click", x: 500, y: 500 }]);

    const browserFrames = h.browserEventsOf<ComputerFrameEvent>(
      browserSocketId,
      target,
      "frame",
    );
    expect(browserFrames).toHaveLength(1);
    expect(browserFrames[0]?.data).toBe("ZnJhbWUtMQ==");

    const browserCursors = h.browserEventsOf<ComputerCursorEvent>(
      browserSocketId,
      target,
      "cursor",
    );
    expect(browserCursors.length).toBeGreaterThanOrEqual(1);
    expect(browserCursors.at(-1)?.kind).toBe("click");

    const linkFramesWhenWatched = h.countLinkFrames(realm.id);
    expect(linkFramesWhenWatched).toBe(1);

    // Browser client #1 unsubscribes -> mirror immediately cools and unsubscribes on the daemon pipe.
    h.primaryWire.unsubscribe(browserSocketId, target);
    await h.flushLink();
    expect(h.mirrors.get(realm.id)?.warm).toBe(false);
    expect(realm.isWatched).toBe(false);
    expect(driverHarness.watchedTransitions).toEqual([true, false]);

    // Further observations while unwatched produce 0 frame traffic across the link.
    await realm.observe();
    await realm.act([{ kind: "move", x: 800, y: 800 }]);
    expect(h.countLinkFrames(realm.id)).toBe(linkFramesWhenWatched);

    h.dispose();
  });

  it("deduplicates replayed events after link drop and reconnect using strictly increasing at timestamps", async () => {
    const h = await createLinkedComputerHarness();
    const driverHarness = createFakeRealmDriver();
    const realm = h.daemonManager.register(driverHarness.driver, {
      id: "realm_dedup_1",
      machineId: h.machineId,
      sessionId: "sess_dedup",
    });

    const target = `computer.${realm.id}`;
    const browserSocketId = 202;
    h.primaryWire.subscribe(browserSocketId, target);
    await h.flushLink();
    expect(realm.isWatched).toBe(true);

    // Emit initial frame (at = 2_000) and picker (updatedAt = 2_100) before link loss.
    realm.emitFrame({
      mimeType: "image/jpeg",
      data: "ZnJhbWUtYmVmb3JlLWRyb3A=",
      viewport: { width: 1280, height: 720 },
      at: 2_000,
    });
    realm.setPickerState({
      status: "armed",
      files: ["doc.pdf"],
      updatedAt: 2_100,
    });

    expect(
      h.browserEventsOf<ComputerFrameEvent>(browserSocketId, target, "frame"),
    ).toHaveLength(1);
    expect(
      h.browserEventsOf<ComputerPickerEvent>(browserSocketId, target, "picker"),
    ).toHaveLength(1);

    const lastAtBeforeDrop = h.mirrors.get(realm.id)!.lastAt;
    expect(lastAtBeforeDrop).toBeGreaterThanOrEqual(2_100);

    // Simulate link loss -> mirror cools (`warm === false`) and daemon realm cools (`isWatched === false`).
    h.dropLink("network drop");
    expect(h.mirrors.get(realm.id)?.warm).toBe(false);
    expect(realm.isWatched).toBe(false);

    // Reconnect link -> mirror automatically re-warms because browserSocketId is still watching!
    // The daemon's WireService replays its EventRing on subscribe, which must be deduplicated.
    await h.reconnectLink();
    expect(h.mirrors.get(realm.id)?.warm).toBe(true);
    expect(realm.isWatched).toBe(true);

    // Verify ring replay on reconnect did not duplicate the pre-drop frame or picker event.
    expect(
      h.browserEventsOf<ComputerFrameEvent>(browserSocketId, target, "frame"),
    ).toHaveLength(1);
    expect(
      h.browserEventsOf<ComputerPickerEvent>(browserSocketId, target, "picker"),
    ).toHaveLength(1);

    // Also emit an explicit event with `at <= lastAt` (filtered) and a newer event with `at > lastAt` (delivered).
    realm.emitFrame({
      mimeType: "image/jpeg",
      data: "c3RhbGUtZnJhbWU=",
      viewport: { width: 1280, height: 720 },
      at: lastAtBeforeDrop,
    });
    realm.emitFrame({
      mimeType: "image/jpeg",
      data: "ZnJhbWUtYWZ0ZXItcmVjb25uZWN0",
      viewport: { width: 1280, height: 720 },
      at: lastAtBeforeDrop + 500,
    });

    const framesAfterReconnect = h.browserEventsOf<ComputerFrameEvent>(
      browserSocketId,
      target,
      "frame",
    );
    expect(framesAfterReconnect.map((f) => f.data)).toEqual([
      "ZnJhbWUtYmVmb3JlLWRyb3A=",
      "ZnJhbWUtYWZ0ZXItcmVjb25uZWN0",
    ]);

    h.dispose();
  });

  it("guards against oversize frames exceeding LINK_LIMITS.maxFrameBytes (8 MiB) on both daemon and mirror", async () => {
    const h = await createLinkedComputerHarness({
      // Also test mirror-side budget enforcement on frames that cross the link but exceed mirror budget
      mirrorMaxFrameBytes: 4_096,
    });
    const driverHarness = createFakeRealmDriver();
    const realm = h.daemonManager.register(driverHarness.driver, {
      id: "realm_budget_1",
      machineId: h.machineId,
    });

    const target = `computer.${realm.id}`;
    const browserSocketId = 303;
    h.primaryWire.subscribe(browserSocketId, target);
    await h.flushLink();

    // 1. Frame exceeding LINK_LIMITS.maxFrameBytes (8 MiB) is blocked on the daemon before Peer.#emit
    //    so it never throws LinkError or closes the link with LINK_CLOSE.tooBig (1009).
    const over8MiB = "A".repeat(LINK_LIMITS.maxFrameBytes + 1024);
    expect(
      isComputerFrameWithinBudget(target, {
        realmId: realm.id,
        seq: 1,
        mimeType: "image/png",
        data: over8MiB,
        viewport: { width: 1280, height: 720 },
        at: 3_000,
      }),
    ).toBe(false);
    expect(
      isWithinFrameBudget(target, {
        realmId: realm.id,
        seq: 1,
        mimeType: "image/png",
        data: over8MiB,
        viewport: { width: 1280, height: 720 },
        at: 3_000,
      }),
    ).toBe(false);

    realm.emitFrame({
      mimeType: "image/png",
      data: over8MiB,
      viewport: { width: 1280, height: 720 },
      at: 3_000,
    });

    // Link was not closed with 1009 tooBig.
    expect(
      h.closeCodes.filter((c) => c.code === LINK_CLOSE.tooBig),
    ).toHaveLength(0);
    expect(
      h.browserEventsOf<ComputerFrameEvent>(browserSocketId, target, "frame"),
    ).toHaveLength(0);

    // 2. Frame under 8 MiB but exceeding mirrorMaxFrameBytes (4 KiB) is dropped by ComputerRealmMirrors.
    const over4KiB = "B".repeat(5_000);
    realm.emitFrame({
      mimeType: "image/jpeg",
      data: over4KiB,
      viewport: { width: 1280, height: 720 },
      at: 3_100,
    });
    expect(
      h.browserEventsOf<ComputerFrameEvent>(browserSocketId, target, "frame"),
    ).toHaveLength(0);

    // 3. Normal frame within budget passes through cleanly.
    realm.emitFrame({
      mimeType: "image/jpeg",
      data: "dmlzaWJsZS1mcmFtZQ==",
      viewport: { width: 1280, height: 720 },
      at: 3_200,
    });
    const delivered = h.browserEventsOf<ComputerFrameEvent>(
      browserSocketId,
      target,
      "frame",
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.data).toBe("dmlzaWJsZS1mcmFtZQ==");

    h.dispose();
  });

  it("forwards takeover, release, pause, resume, stop, input, resolvePicker, and close actions to the daemon's RealmManager", async () => {
    const h = await createLinkedComputerHarness();
    const driverHarness = createFakeRealmDriver();
    const realm = h.daemonManager.register(driverHarness.driver, {
      id: "realm_actions_1",
      machineId: h.machineId,
    });

    const target = `computer.${realm.id}`;

    // 1. takeover -> controller transitions to "user" on daemon, epoch increments to 2
    const afterTakeover = await h.callPrimary<ComputerRealmView>(
      target,
      "takeover",
      { reason: "User debugging" },
    );
    expect(afterTakeover.controller).toBe("user");
    expect(afterTakeover.epoch).toBe(2);
    expect(realm.controller).toBe("user");
    expect(realm.epoch).toBe(2);

    // 2. input while controller === "user" -> reaches daemon driver.userInput
    const clickInput: ComputerUserInput = {
      kind: "click",
      x: 420,
      y: 680,
    };
    const afterInput = await h.callPrimary<ComputerRealmView>(target, "input", {
      input: clickInput,
    });
    expect(driverHarness.executedUserInputs).toEqual([clickInput]);
    expect(afterInput.cursor.x).toBe(420);
    expect(afterInput.cursor.y).toBe(680);

    // 3. release -> controller transitions back to "agent", epoch increments to 3
    const afterRelease = await h.callPrimary<ComputerRealmView>(
      target,
      "release",
    );
    expect(afterRelease.controller).toBe("agent");
    expect(afterRelease.epoch).toBe(3);
    expect(realm.controller).toBe("agent");

    // 4. pause & resume
    const afterPause = await h.callPrimary<ComputerRealmView>(target, "pause");
    expect(afterPause.controller).toBe("paused");
    expect(realm.controller).toBe("paused");

    const afterResume = await h.callPrimary<ComputerRealmView>(
      target,
      "resume",
    );
    expect(afterResume.controller).toBe("agent");
    expect(realm.controller).toBe("agent");

    // 5. stop -> controller transitions to "paused"
    const afterStop = await h.callPrimary<ComputerRealmView>(target, "stop");
    expect(afterStop.controller).toBe("paused");
    expect(realm.controller).toBe("paused");

    // 6. resolvePicker -> forwards files to daemon realm
    const pickerState = await h.callPrimary<ComputerPickerState>(
      target,
      "resolvePicker",
      { files: ["spec.md", "diagram.png"] },
    );
    expect(pickerState.status).toBe("intercepted_silent");
    expect(pickerState.files).toEqual(["spec.md", "diagram.png"]);
    expect(driverHarness.resolvedPickers).toEqual([["spec.md", "diagram.png"]]);

    // 7. close -> closes daemon realm
    const afterClose = await h.callPrimary<ComputerRealmView>(target, "close");
    expect(afterClose.controller).toBe("closed");
    expect(realm.controller).toBe("closed");
    expect(driverHarness.closedCount()).toBe(1);

    h.dispose();
  });
});
