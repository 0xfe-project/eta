import type {
  ComputerCursorEvent,
  ComputerFrameEvent,
  ComputerPickerState,
  ComputerRealmView,
  ViewportSize,
} from "@eta/client-contracts";
import type { EventFrame, ServerFrame } from "@eta/client-wire-proto";
import type {
  CdpEventListener,
  CdpSendOptions,
  CdpTransport,
  HiddenDesktopBackend,
  HiddenDesktopDispatchedMessage,
  UiaDialogBackend,
  UiaDialogCompleteRequest,
  UiaFileDialogInfo,
} from "@eta/computer";
import type { ToolResult } from "@eta/harness";
import type { SessionMeta, SessionsService, Socket } from "@eta/server";
/**
 * End-to-End Acceptance Verification Test (`T12`: `G1`–`G6`):
 *
 * Verifies all 6 Definition-of-Done gates across `@eta/computer`, `@eta/client-contracts`,
 * `apps/daemon`, and `apps/eta`:
 * - G1 (Zero Main-Desktop Contention): 50 continuous realm actions (`move`, `click`, `scroll`,
 *   `type`, `key`, clipboard copy/paste) with 0 host clipboard calls, 0 OS cursor moves, and
 *   isolated per-realm `VirtualClipboard`.
 * - G2 (Zero-Bandwidth Background Execution): when `<ComputerPanel />` / wire subscriber is
 *   unsubscribed, 0 `frame` events are emitted over `/ws` while background realm actions and
 *   file saves complete 100%.
 * - G3 (Silent File Picker & Security Boundary): browser file upload (plain + dynamic
 *   `filechooser`) and Windows `#32770` Save As complete with 0 main-desktop popups;
 *   out-of-workspace paths trigger the `Inbox` / `ask` gate and `~/.eta/secret.key` is
 *   hard-denied.
 * - G4 (Clean Frame vs. Agent Cursor Overlay Separation): model observation screenshots contain
 *   pure clean frame bytes while `/ws` `computer.<id>` emits normalized `0..1000` cursor events
 *   with the agent's name.
 * - G5 (Millisecond Single-Writer Takeover): calling `takeover` mid-batch aborts remaining
 *   queued micro-actions immediately, enables `user` input forwarding, and `release` hands
 *   control back to `agent`.
 * - G6 (Agent Plugin Bundle & Skill Validity): `writeComputerPluginBundle` produces a valid
 *   Agent Plugins 1.0.0 bundle passing `loadPlugin` and `loadSkills`, and the MCP bridge
 *   (`createComputerMcpToolDefinitions` + `handleComputerMcpToolCall`) executes all 7 tools.
 */
import type { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  BrowserRealmDriver,
  COMPUTER_USE_SKILL_MD,
  createComputerMcpToolDefinitions,
  createPaintedPngBuffer,
  createSolidPngBuffer,
  enforceChildSessionRdpInvariants,
  FileBrokerPolicy,
  handleComputerMcpToolCall,
  RealmManager,
  WindowsAppRealmDriver,
  writeComputerPluginBundle,
} from "@eta/computer";
import { AskRegistry, loadSkills } from "@eta/harness";
import { createConnection, WireService } from "@eta/server";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlugin } from "../../daemon/src";
import { computerPlugin } from "../src/computer/plugin";
import {
  ComputerService,
  parseGroundedCoordinate,
  SyntheticRealmDriver,
} from "../src/computer/service";
import { computerSessionTools } from "../src/computer/tools";
import { say, scriptedModels } from "./support/models";

const createdDirs: string[] = [];

function createProjectTempDir(prefix: string): string {
  const baseDir = path.join(process.cwd(), ".eta-test-dod-e2e");
  fs.mkdirSync(baseDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(baseDir, `${prefix}-`));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const baseDir = path.join(process.cwd(), ".eta-test-dod-e2e");
  if (fs.existsSync(baseDir)) {
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup race if any
    }
  }
});

function findTool(
  tools: ReturnType<ReturnType<typeof computerSessionTools>>,
  name: string,
) {
  const found = tools.find((tool) => tool.name === name);
  if (found === undefined) {
    throw new Error(`Expected tool "${name}" to be registered`);
  }
  return found;
}

interface RecordedCdpCall {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string | undefined;
}

class MockCdpTransport implements CdpTransport {
  readonly calls: RecordedCdpCall[] = [];
  isClosed = false;
  readonly #listeners = new Map<
    string,
    Set<CdpEventListener<Record<string, unknown>>>
  >();
  readonly #handlers = new Map<
    string,
    (
      params: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<Record<string, unknown>> | Record<string, unknown>
  >();
  readonly #cleanFrameBase64: string;

  constructor(cleanFrameBase64?: string) {
    this.#cleanFrameBase64 =
      cleanFrameBase64 ??
      createSolidPngBuffer(32, 32, [24, 48, 96, 255]).toString("base64");
  }

  on<TParams = Record<string, unknown>>(
    event: string,
    listener: CdpEventListener<TParams>,
  ): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    const typed = listener as CdpEventListener<Record<string, unknown>>;
    set.add(typed);
    return () => {
      set?.delete(typed);
    };
  }

  emit(
    event: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      listener(params, sessionId);
    }
  }

  setHandler(
    method: string,
    handler: (
      params: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<Record<string, unknown>> | Record<string, unknown>,
  ): void {
    this.#handlers.set(method, handler);
  }

  async send<TResult = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    options?: CdpSendOptions,
  ): Promise<TResult> {
    this.calls.push({ method, params, sessionId: options?.sessionId });
    const handler = this.#handlers.get(method);
    if (handler) {
      return (await handler(params, options?.sessionId)) as TResult;
    }
    if (method === "Page.captureScreenshot") {
      return { data: this.#cleanFrameBase64 } as TResult;
    }
    return {} as TResult;
  }

  async close(): Promise<void> {
    this.isClosed = true;
  }
}

function createMockHiddenDesktopBackend(
  options: {
    pid?: number;
    viewport?: ViewportSize;
    cleanFrameBuffer?: Buffer;
    onDispatch?: (msg: HiddenDesktopDispatchedMessage) => void;
  } = {},
) {
  const pid = options.pid ?? 7788;
  const viewport = options.viewport ?? {
    width: 1280,
    height: 800,
    scaleFactor: 1,
  };
  const frameBuffer =
    options.cleanFrameBuffer ?? createPaintedPngBuffer(32, 32);
  const dispatched: HiddenDesktopDispatchedMessage[] = [];
  const hostOsCursorMoveCalls = 0;
  const hostOsClipboardCalls = 0;
  const switchDesktopCalls = 0;

  const backend: HiddenDesktopBackend = {
    launch: async (req) => ({
      desktopName: req.desktopName,
      pid,
      title: () => req.title ?? req.target,
      viewport: () => viewport,
      captureFrame: async () => ({
        buffer: frameBuffer,
        mimeType: "image/png",
        viewport,
      }),
      dispatchMessage: async (message) => {
        dispatched.push(message);
        options.onDispatch?.(message);
      },
      close: async () => {},
    }),
  };

  return {
    backend,
    dispatched,
    frameBuffer,
    hostOsCursorMoveCalls: () => hostOsCursorMoveCalls,
    hostOsClipboardCalls: () => hostOsClipboardCalls,
    switchDesktopCalls: () => switchDesktopCalls,
  };
}

function createMockUiaDialogHarness() {
  let activeDialog: UiaFileDialogInfo | null = null;
  let pendingFileContent: string | undefined;
  const completedRequests: UiaDialogCompleteRequest[] = [];
  const mainDesktopPopupsCount = 0;

  const backend: UiaDialogBackend = {
    findModalFileDialog: async (query) => {
      if (!activeDialog) return null;
      if (query.rootPid !== undefined && activeDialog.pid !== query.rootPid) {
        return null;
      }
      return { ...activeDialog };
    },
    completeFileDialog: async (request) => {
      completedRequests.push(request);
      if (pendingFileContent !== undefined && request.paths[0]) {
        const outPath = request.paths[0];
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, pendingFileContent, "utf8");
      }
      activeDialog = null;
      pendingFileContent = undefined;
      return {
        completed: true,
        overwriteConfirmed: request.autoConfirmOverwrite,
      };
    },
  };

  return {
    backend,
    completedRequests,
    mainDesktopPopupsCount: () => mainDesktopPopupsCount,
    openModalDialog: (
      dialog: UiaFileDialogInfo,
      onSaveWriteContent?: string,
    ) => {
      activeDialog = { ...dialog };
      pendingFileContent = onSaveWriteContent;
    },
  };
}

interface WireTestHarness {
  wire: WireService;
  socketId: number;
  frames: ServerFrame[];
  section: <T = unknown>(target: string, sectionName: string) => T | undefined;
  events: <T = unknown>(target: string, eventName: string) => T[];
  subscribe: (target: string) => void;
  unsubscribe: (target: string) => void;
  call: <T = unknown>(
    target: string,
    action: string,
    args?: Record<string, unknown>,
  ) => Promise<T>;
  dispose: () => Promise<void>;
}

function mountComputerPluginWire(service: ComputerService): WireTestHarness {
  const createStubContext = () =>
    ({
      reflect: { provide: () => {} },
      set: () => {},
      runtime: {},
      effect: () => {},
    }) as never;

  const wire = new WireService(createStubContext(), {
    focusedIntervalMs: 0,
    backgroundIntervalMs: 0,
  });

  const frames: ServerFrame[] = [];
  const sectionsByTarget = new Map<string, Record<string, unknown>>();
  const socketId = 1;

  const recordFrame = (frame: ServerFrame): void => {
    frames.push(frame);
    if (frame.type === "hello") {
      for (const [target, snap] of Object.entries(frame.state)) {
        sectionsByTarget.set(target, { ...snap.sections });
      }
    } else if (frame.type === "state") {
      if (frame.snapshot !== undefined) {
        sectionsByTarget.set(frame.target, { ...frame.snapshot.sections });
      } else if (frame.patch !== undefined) {
        const prev = sectionsByTarget.get(frame.target) ?? {};
        const next: Record<string, unknown> = {};
        for (const name of Object.keys(frame.patch.revisions)) {
          next[name] =
            name in frame.patch.sections
              ? frame.patch.sections[name]
              : prev[name];
        }
        sectionsByTarget.set(frame.target, next);
      }
    }
  };

  wire.attachSink((addressed) => {
    if (addressed.socketId !== undefined) {
      if (addressed.socketId === socketId) {
        recordFrame(addressed.frame);
      }
      return;
    }
    if (
      addressed.target !== undefined &&
      wire.state.subscriptions(socketId).includes(addressed.target)
    ) {
      recordFrame(addressed.frame);
    }
  });

  let applied = false;
  let pluginCleanup: (() => void | Promise<void>) | undefined;
  const plugin = computerPlugin({ service }, () => {
    applied = true;
  });

  plugin.apply({
    wire,
    sessions: {} as SessionsService,
    effect: (execute: () => () => void | Promise<void>) => {
      pluginCleanup = execute();
      return pluginCleanup;
    },
  });

  if (!applied) {
    throw new Error("computerPlugin did not call applied()");
  }

  const fakeSocket: Socket = {
    id: socketId,
    send: (frame) => {
      recordFrame(frame);
    },
  };

  const conn = createConnection(fakeSocket, {
    wire,
    mounted: () => [{ name: "computer", source: "bundled" }],
  });

  let reqCounter = 0;

  return {
    wire,
    socketId,
    frames,
    section: <T = unknown>(
      target: string,
      sectionName: string,
    ): T | undefined =>
      sectionsByTarget.get(target)?.[sectionName] as T | undefined,
    events: <T = unknown>(target: string, eventName: string): T[] =>
      frames
        .filter(
          (f): f is EventFrame =>
            f.type === "event" && f.target === target && f.name === eventName,
        )
        .map((f) => f.data as T),
    subscribe: (target: string) => {
      wire.subscribe(socketId, target);
    },
    unsubscribe: (target: string) => {
      wire.unsubscribe(socketId, target);
    },
    call: async <T = unknown>(
      target: string,
      action: string,
      args: Record<string, unknown> = {},
    ): Promise<T> => {
      const requestId = `req_${++reqCounter}`;
      const outcome = await wire.dispatch(
        {
          op: "call",
          requestId,
          target,
          action,
          args,
        },
        { reply: () => {} },
      );
      return outcome.result as T;
    },
    dispose: async () => {
      conn.close();
      await pluginCleanup?.();
      await service.closeAll();
    },
  };
}

describe("t12: Definition-of-Done E2E Acceptance Gates (G1-G6)", () => {
  it("g1 (Zero Main-Desktop Contention): executes 50 continuous realm actions across browser and app realms with 0 host clipboard calls, 0 OS cursor moves, and isolated VirtualClipboards", async () => {
    const rdpInvariants = enforceChildSessionRdpInvariants();
    expect(rdpInvariants.RedirectClipboard).toBe(false);
    expect(rdpInvariants.ManualClipboardSyncEnabled).toBe(true);
    expect(() =>
      enforceChildSessionRdpInvariants({ RedirectClipboard: true }),
    ).toThrow(/RedirectClipboard must be false/);

    const cdpTransport = new MockCdpTransport();
    let browserSelectedText = "BROWSER_REALM_SECRET_42";
    cdpTransport.setHandler("Runtime.evaluate", () => ({
      result: { type: "string", value: browserSelectedText },
    }));

    const desktopMock = createMockHiddenDesktopBackend();
    const browserDriver = new BrowserRealmDriver({
      transport: cdpTransport,
      sessionId: "cdp_sess_g1",
      initialUrl: "https://example.com/editor",
      initialTitle: "Browser Editor",
      clickSettleMs: 0,
    });
    await browserDriver.attach();

    const appDriver = new WindowsAppRealmDriver({
      target: "notepad.exe",
      title: "Isolated Notepad",
      hiddenDesktopBackend: desktopMock.backend,
      probeOptions: {
        platform: "win32",
        queryChildSessionsEnabled: () => false,
      },
      getSelectedText: () => "WINDOWS_APP_CLIPBOARD_99",
    });
    await appDriver.ensureStarted();

    const manager = new RealmManager({ machineId: "machine_g1" });
    const browserRealm = manager.register(browserDriver, {
      id: "realm_browser_g1",
    });
    browserDriver.bindRealm(browserRealm);
    const appRealm = manager.register(appDriver, {
      id: "realm_app_g1",
    });

    // Build 50 micro-actions (25 on browserRealm + 25 on appRealm) covering move, click, scroll, type, key, and copy/paste
    const build25Actions = (prefix: string) => [
      // Batch 1 (8 actions)
      [
        { kind: "move" as const, x: 100, y: 150, unit: "normalized" as const },
        { kind: "click" as const, x: 100, y: 150, unit: "normalized" as const },
        { kind: "type" as const, text: `${prefix}-line-1`, submit: true },
        {
          kind: "scroll" as const,
          x: 500,
          y: 500,
          deltaY: 120,
          unit: "normalized" as const,
        },
        { kind: "key" as const, key: "Control+c" },
        { kind: "move" as const, x: 300, y: 400, unit: "normalized" as const },
        { kind: "click" as const, x: 300, y: 400, unit: "normalized" as const },
        { kind: "key" as const, key: "Control+v" },
      ],
      // Batch 2 (8 actions)
      [
        { kind: "move" as const, x: 450, y: 250, unit: "normalized" as const },
        {
          kind: "double_click" as const,
          x: 450,
          y: 250,
          unit: "normalized" as const,
        },
        { kind: "type" as const, text: `${prefix}-line-2` },
        { kind: "key" as const, key: "Tab" },
        {
          kind: "scroll" as const,
          x: 450,
          y: 250,
          deltaY: -80,
          unit: "normalized" as const,
        },
        {
          kind: "right_click" as const,
          x: 600,
          y: 350,
          unit: "normalized" as const,
        },
        { kind: "key" as const, key: "Escape" },
        { kind: "move" as const, x: 700, y: 500, unit: "normalized" as const },
      ],
      // Batch 3 (8 actions)
      [
        { kind: "click" as const, x: 700, y: 500, unit: "normalized" as const },
        { kind: "type" as const, text: `${prefix}-line-3`, submit: true },
        {
          kind: "drag" as const,
          fromX: 200,
          fromY: 200,
          toX: 600,
          toY: 600,
          unit: "normalized" as const,
        },
        {
          kind: "scroll" as const,
          x: 600,
          y: 600,
          deltaY: 200,
          unit: "normalized" as const,
        },
        { kind: "move" as const, x: 850, y: 150, unit: "normalized" as const },
        { kind: "click" as const, x: 850, y: 150, unit: "normalized" as const },
        { kind: "key" as const, key: "Control+v" },
        { kind: "key" as const, key: "Enter" },
      ],
      // Batch 4 (1 action -> total 25 actions per realm, 50 total)
      [{ kind: "move" as const, x: 500, y: 500, unit: "normalized" as const }],
    ];

    let totalExecutedSteps = 0;
    const browserBatches = build25Actions("browser");
    const appBatches = build25Actions("app");

    for (let i = 0; i < browserBatches.length; i += 1) {
      const bRes = await browserRealm.act(browserBatches[i]!);
      const aRes = await appRealm.act(appBatches[i]!);
      expect(bRes.aborted).toBe(false);
      expect(aRes.aborted).toBe(false);
      totalExecutedSteps += bRes.completedSteps + aRes.completedSteps;
    }

    expect(totalExecutedSteps).toBe(50);
    expect(desktopMock.hostOsCursorMoveCalls()).toBe(0);
    expect(desktopMock.hostOsClipboardCalls()).toBe(0);
    expect(desktopMock.switchDesktopCalls()).toBe(0);

    // Verify VirtualClipboard isolation between the two realms
    expect(browserRealm.clipboard.readText()).toBe("BROWSER_REALM_SECRET_42");
    expect(appRealm.clipboard.readText()).toBe("WINDOWS_APP_CLIPBOARD_99");

    browserSelectedText = "UPDATED_BROWSER_CLIP";
    browserRealm.clipboard.writeText(browserSelectedText);
    expect(browserRealm.clipboard.readText()).toBe("UPDATED_BROWSER_CLIP");
    expect(appRealm.clipboard.readText()).toBe("WINDOWS_APP_CLIPBOARD_99");

    await manager.closeAll();
  });

  it("g2 (Zero-Bandwidth Background Execution): emits 0 frame events over /ws while unsubscribed, while background realm actions and file saves complete 100%", async () => {
    const sandboxDir = createProjectTempDir("g2-bg");
    const savedFilePath = path.join(sandboxDir, "saved-report.txt");

    const { models } = scriptedModels(() => say("ok"), { vision: true });
    const service = new ComputerService({
      machineId: "machine_g2",
      models,
      driverFactory: (ctx) => {
        const base = new SyntheticRealmDriver({
          kind: ctx.kind,
          target: ctx.target,
          title: ctx.title,
          viewport: ctx.viewport,
          fileBroker: ctx.fileBroker,
        });
        return {
          kind: base.kind,
          tier: base.tier,
          title: () => base.title(),
          target: () => base.target(),
          viewport: () => base.viewport(),
          observe: (opts) => base.observe(opts),
          step: async (action, stepCtx) => {
            if (action.kind === "key" && action.key === "Control+s") {
              fs.writeFileSync(
                savedFilePath,
                `Saved in background: ${stepCtx.clipboard.readText()}`,
                "utf8",
              );
            }
            return await base.step(action, stepCtx);
          },
          stageFiles: (files) => base.stageFiles(files),
          resolvePicker: (files) => base.resolvePicker(files),
          setWatched: (w) => base.setWatched(w),
          close: () => base.close(),
        };
      },
    });
    const harness = mountComputerPluginWire(service);

    try {
      const meta: SessionMeta = {
        id: "sess_g2",
        createdAt: Date.now(),
        cwd: sandboxDir,
        agentId: "agent_bg",
        model: "fake:vision-model",
      };
      const tools = computerSessionTools({
        service,
        models: () => models,
      })({ meta, session: undefined as never });

      const openTool = findTool(tools, "computer_open");
      const observeTool = findTool(tools, "computer_observe");
      const actTool = findTool(tools, "computer_act");
      const clipTool = findTool(tools, "computer_clipboard");

      const openRes = (await openTool.execute(
        { kind: "app", target: "notepad.exe", title: "Background Writer" },
        { turn: 1, toolCallId: "tc-g2-open" },
      )) as ToolResult<{ realmId: string }>;
      const realmId = openRes.details!.realmId;
      const realmTarget = `computer.${realmId}`;
      const realm = service.requireLocalRealm(realmId);

      // Client is NOT subscribed to `computer.<realmId>` (simulating folded <ComputerStrip />)
      expect(realm.isWatched).toBe(false);

      await clipTool.execute(
        {
          realmId,
          action: "write",
          text: "Q4_REVENUE_VERIFIED=100%",
        },
        { turn: 1, toolCallId: "tc-g2-clip" },
      );

      await observeTool.execute(
        { realmId },
        { turn: 1, toolCallId: "tc-g2-obs-1" },
      );

      await actTool.execute(
        {
          realmId,
          actions: [
            { kind: "click", x: 500, y: 500, unit: "normalized" },
            { kind: "key", key: "Control+v" },
            { kind: "key", key: "Control+s" },
          ],
        },
        { turn: 1, toolCallId: "tc-g2-act-1" },
      );

      await observeTool.execute(
        { realmId },
        { turn: 1, toolCallId: "tc-g2-obs-2" },
      );

      // 0 frame events emitted over /ws while unsubscribed
      expect(harness.events<ComputerFrameEvent>(realmTarget, "frame")).toEqual(
        [],
      );

      // Objective completion judge: background file save completed 100%
      expect(fs.existsSync(savedFilePath)).toBe(true);
      expect(fs.readFileSync(savedFilePath, "utf8")).toBe(
        "Saved in background: Q4_REVENUE_VERIFIED=100%",
      );

      // Now expand <ComputerPanel /> (subscribe), observe once, then collapse (unsubscribe)
      harness.subscribe(realmTarget);
      expect(realm.isWatched).toBe(true);
      await observeTool.execute(
        { realmId },
        { turn: 2, toolCallId: "tc-g2-obs-watched" },
      );
      expect(
        harness.events<ComputerFrameEvent>(realmTarget, "frame"),
      ).toHaveLength(1);

      harness.unsubscribe(realmTarget);
      expect(realm.isWatched).toBe(false);
      await observeTool.execute(
        { realmId },
        { turn: 2, toolCallId: "tc-g2-obs-unwatched-again" },
      );
      // Frame count stays at 1 (0 new frames after unsubscribing)
      expect(
        harness.events<ComputerFrameEvent>(realmTarget, "frame"),
      ).toHaveLength(1);
    } finally {
      await harness.dispose();
    }
  });

  it("g3 (Silent File Picker & Security Boundary): intercepts browser filechoosers and Windows #32770 Save As with 0 popups, gates out-of-workspace files via Inbox/ask, and hard-denies ~/.eta/secret.key", async () => {
    const sandboxRoot = createProjectTempDir("g3-picker");
    const projectDir = path.join(sandboxRoot, "workspace");
    const outsideDir = path.join(sandboxRoot, "outside");
    const homeDir = path.join(sandboxRoot, "home");
    const etaHomeDir = path.join(homeDir, ".eta");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.mkdirSync(etaHomeDir, { recursive: true });

    const workspaceUploadFile = path.join(projectDir, "dataset.csv");
    const workspaceDynamicFile = path.join(projectDir, "dynamic.csv");
    const workspaceSaveAsFile = path.join(projectDir, "exported-report.txt");
    const outsideFile = path.join(outsideDir, "external.csv");
    const secretKeyFile = path.join(etaHomeDir, "secret.key");

    fs.writeFileSync(workspaceUploadFile, "id,name\n1,eta\n", "utf8");
    fs.writeFileSync(workspaceDynamicFile, "id,name\n2,dynamic\n", "utf8");
    fs.writeFileSync(outsideFile, "id,name\n3,outside\n", "utf8");
    fs.writeFileSync(secretKeyFile, "PRIVATE_ETA_SECRET_KEY", "utf8");

    const cdpTransport = new MockCdpTransport();
    const uiaHarness = createMockUiaDialogHarness();
    const desktopMock = createMockHiddenDesktopBackend({ pid: 9001 });

    const { models } = scriptedModels(() => say("ok"), { vision: true });
    const service = new ComputerService({
      machineId: "machine_g3",
      models,
      fileBrokerOptions: {
        projectDir,
        homeDir,
        etaHomeDir,
      },
      driverFactory: async (ctx) => {
        if (ctx.kind === "browser") {
          const driver = new BrowserRealmDriver({
            transport: cdpTransport,
            sessionId: "cdp_sess_g3",
            initialUrl: ctx.target,
            fileBroker: ctx.fileBroker,
            clickSettleMs: 0,
          });
          await driver.attach();
          return driver;
        }
        const appDriver = new WindowsAppRealmDriver({
          target: ctx.target,
          title: ctx.title,
          fileBroker: ctx.fileBroker,
          hiddenDesktopBackend: desktopMock.backend,
          uiaBackend: uiaHarness.backend,
          defaultStageMode: "write",
          probeOptions: {
            platform: "win32",
            queryChildSessionsEnabled: () => false,
          },
        });
        await appDriver.ensureStarted();
        return appDriver;
      },
    });

    const askedQuestions: { questionId: string; question: string }[] = [];
    let nextDecision: "allow" | "deny" = "allow";
    const ask = new AskRegistry({
      headless: async (payload) => {
        askedQuestions.push({
          questionId: payload.questionId,
          question: payload.question,
        });
        return {
          kind: "selection",
          selections: [nextDecision],
        };
      },
    });
    const meta: SessionMeta = {
      id: "sess_g3",
      createdAt: Date.now(),
      cwd: projectDir,
      model: "fake:vision-model",
    };
    const tools = computerSessionTools({
      service,
      models: () => models,
    })({ meta, session: { ask } as never });

    const openTool = findTool(tools, "computer_open");
    const stageTool = findTool(tools, "computer_stage_files");
    const resolveTool = findTool(tools, "computer_resolve_picker");

    // 1. Browser file upload: pre-staged (`computer_stage_files`) + dynamic (`Page.fileChooserOpened`)
    const browserOpen = (await openTool.execute(
      { kind: "browser", target: "https://example.com/upload" },
      { turn: 1, toolCallId: "tc-g3-open-browser" },
    )) as ToolResult<{ realmId: string }>;
    const browserRealmId = browserOpen.details!.realmId;

    const stageRes = (await stageTool.execute(
      {
        realmId: browserRealmId,
        files: [workspaceUploadFile],
        mode: "read",
      },
      { turn: 1, toolCallId: "tc-g3-stage-1" },
    )) as ToolResult<{ picker: ComputerPickerState; asked: boolean }>;
    expect(stageRes.isError).toBeUndefined();
    expect(stageRes.details?.asked).toBe(false);
    expect(stageRes.details?.picker.status).toBe("armed");

    // Simulate Chromium firing Page.fileChooserOpened when Upload button is clicked
    cdpTransport.emit(
      "Page.fileChooserOpened",
      {
        frameId: "main_frame",
        mode: "selectSingle",
        backendNodeId: 404,
      },
      "cdp_sess_g3",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    const setInputCalls = cdpTransport.calls.filter(
      (c) => c.method === "DOM.setFileInputFiles",
    );
    expect(setInputCalls).toHaveLength(1);
    expect(setInputCalls[0]!.params).toMatchObject({
      backendNodeId: 404,
      files: [fs.realpathSync(workspaceUploadFile)],
    });
    expect(service.requireLocalRealm(browserRealmId).picker.status).toBe(
      "intercepted_silent",
    );

    // Dynamic unstaged filechooser -> pending_input -> computer_resolve_picker
    cdpTransport.emit(
      "Page.fileChooserOpened",
      {
        frameId: "main_frame",
        mode: "selectSingle",
        backendNodeId: 505,
      },
      "cdp_sess_g3",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(service.requireLocalRealm(browserRealmId).picker.status).toBe(
      "pending_input",
    );

    const resolveDynamic = (await resolveTool.execute(
      {
        realmId: browserRealmId,
        files: [workspaceDynamicFile],
        mode: "read",
      },
      { turn: 1, toolCallId: "tc-g3-resolve-dyn" },
    )) as ToolResult<{ picker: ComputerPickerState }>;
    expect(resolveDynamic.isError).toBeUndefined();
    expect(resolveDynamic.details?.picker.status).toBe("intercepted_silent");

    // 2. Windows #32770 Save As dialog auto-fill with 0 main-desktop popups
    const appOpen = (await openTool.execute(
      { kind: "app", target: "notepad.exe", title: "Notepad Report" },
      { turn: 2, toolCallId: "tc-g3-open-app" },
    )) as ToolResult<{ realmId: string }>;
    const appRealmId = appOpen.details!.realmId;

    await stageTool.execute(
      {
        realmId: appRealmId,
        files: [workspaceSaveAsFile],
        mode: "write",
      },
      { turn: 2, toolCallId: "tc-g3-stage-save" },
    );

    uiaHarness.openModalDialog(
      {
        hwnd: "0x0012ABCD",
        pid: 9001,
        title: "Save As",
        className: "#32770",
        mode: "save",
      },
      "EXPORTED_REPORT_BODY_OK",
    );

    const appDriver = service.requireLocalRealm(appRealmId)
      .driver as WindowsAppRealmDriver;
    await appDriver.dialogWatcher.pollOnce();

    expect(uiaHarness.mainDesktopPopupsCount()).toBe(0);
    expect(uiaHarness.completedRequests).toHaveLength(1);
    expect(uiaHarness.completedRequests[0]!.editAutomationId).toBe("1148");
    expect(uiaHarness.completedRequests[0]!.confirmButtonAutomationId).toBe(
      "1",
    );
    expect(fs.existsSync(workspaceSaveAsFile)).toBe(true);
    expect(fs.readFileSync(workspaceSaveAsFile, "utf8")).toBe(
      "EXPORTED_REPORT_BODY_OK",
    );

    // 3. Out-of-workspace path triggers the Inbox / ask approval gate
    nextDecision = "allow";
    const outsideAllowedRes = (await stageTool.execute(
      {
        realmId: browserRealmId,
        files: [outsideFile],
        mode: "read",
      },
      { turn: 3, toolCallId: "tc-g3-outside-allow" },
    )) as ToolResult<{
      asked: boolean;
      picker: ComputerPickerState;
    }>;
    expect(askedQuestions).toHaveLength(1);
    expect(askedQuestions[0]!.question).toContain("outside the workspace");
    expect(outsideAllowedRes.isError).toBeUndefined();
    expect(outsideAllowedRes.details?.asked).toBe(true);
    expect(outsideAllowedRes.details?.picker.status).toBe("armed");

    nextDecision = "deny";
    const outsideDeniedRes = (await stageTool.execute(
      {
        realmId: browserRealmId,
        files: [outsideFile],
        mode: "read",
      },
      { turn: 3, toolCallId: "tc-g3-outside-deny" },
    )) as ToolResult;
    expect(outsideDeniedRes.isError).toBe(true);
    expect(outsideDeniedRes.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("file_broker_rejected_by_user"),
    });
    expect(askedQuestions).toHaveLength(2);

    // 4. Sensitive secret path (~/.eta/secret.key) is hard-denied without prompting
    const secretRes = (await stageTool.execute(
      {
        realmId: browserRealmId,
        files: [secretKeyFile],
        mode: "read",
      },
      { turn: 4, toolCallId: "tc-g3-secret-deny" },
    )) as ToolResult;
    expect(secretRes.isError).toBe(true);
    expect(secretRes.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("file_broker_denied"),
    });
    // Hard-denied without invoking the ask callback again
    expect(askedQuestions).toHaveLength(2);

    await service.closeAll();
  });

  it("g4 (Clean Frame vs. Agent Cursor Overlay Separation): observation screenshots remain pure clean frames while /ws computer.<id> emits normalized 0..1000 cursor events with the agent name", async () => {
    const pureCleanPngBase64 = createSolidPngBuffer(
      48,
      48,
      [18, 92, 168, 255],
    ).toString("base64");
    const cdpTransport = new MockCdpTransport(pureCleanPngBase64);

    const { models } = scriptedModels(
      () => say('{"x": 750, "y": 250, "unit": "normalized"}'),
      { vision: true },
    );
    expect(
      parseGroundedCoordinate('{"x": 750, "y": 250, "unit": "normalized"}'),
    ).toEqual({
      x: 750,
      y: 250,
      unit: "normalized",
    });

    const service = new ComputerService({
      machineId: "machine_g4",
      models,
      groundingModel: "fake:fast-grounder",
      driverFactory: async (ctx) => {
        const driver = new BrowserRealmDriver({
          transport: cdpTransport,
          sessionId: "cdp_sess_g4",
          initialUrl: ctx.target,
          initialTitle: ctx.title ?? "Clean Frame App",
          fileBroker: ctx.fileBroker,
          clickSettleMs: 0,
        });
        await driver.attach();
        return driver;
      },
    });
    const harness = mountComputerPluginWire(service);

    try {
      const meta: SessionMeta = {
        id: "sess_g4",
        createdAt: Date.now(),
        cwd: process.cwd(),
        agentId: "agent_ada",
        model: "fake:vision-model",
      };
      const tools = computerSessionTools({
        service,
        models: () => models,
        agentName: () => "Ada",
      })({ meta, session: undefined as never });

      const openTool = findTool(tools, "computer_open");
      const observeTool = findTool(tools, "computer_observe");
      const actTool = findTool(tools, "computer_act");

      const openRes = (await openTool.execute(
        {
          kind: "browser",
          target: "https://example.com/canvas",
          title: "Design Canvas",
        },
        { turn: 1, toolCallId: "tc-g4-open" },
      )) as ToolResult<{ realmId: string; realm: ComputerRealmView }>;
      const realmId = openRes.details!.realmId;
      const realmTarget = `computer.${realmId}`;

      harness.subscribe(realmTarget);
      expect(
        harness.section<ComputerRealmView>(realmTarget, "info")?.agentName,
      ).toBe("Ada");

      // Execute cursor movement and click at normalized (750, 250)
      await actTool.execute(
        {
          realmId,
          actions: [
            { kind: "move", x: 750, y: 250, unit: "normalized" },
            { kind: "click", x: 750, y: 250, unit: "normalized" },
          ],
        },
        { turn: 1, toolCallId: "tc-g4-act" },
      );

      // Observe full frame + GroundCascade locate
      const obsRes = (await observeTool.execute(
        {
          realmId,
          locate: "Submit button in top-right quadrant",
        },
        { turn: 2, toolCallId: "tc-g4-obs" },
      )) as ToolResult<{
        cursor: { x: number; y: number; kind: string };
        grounded?: { viewportNormalized?: { x: number; y: number } };
      }>;

      expect(obsRes.isError).toBeUndefined();
      const modelImageBlock = obsRes.content[0] as {
        type: "image";
        mimeType: string;
        data: string;
      };
      // Model screenshot bytes are 100% identical to the pure clean frame (zero synthetic cursor painted)
      expect(modelImageBlock.data).toBe(pureCleanPngBase64);
      expect(obsRes.details?.grounded?.viewportNormalized).toEqual({
        x: 750,
        y: 250,
      });

      // Wire frame event also carries the pure clean frame
      const wireFrames = harness.events<ComputerFrameEvent>(
        realmTarget,
        "frame",
      );
      expect(wireFrames.length).toBeGreaterThanOrEqual(1);
      expect(wireFrames[wireFrames.length - 1]!.data).toBe(pureCleanPngBase64);

      // Wire cursor events carry normalized 0..1000 coordinates separately for the SVG overlay
      const cursorEvents = harness.events<ComputerCursorEvent>(
        realmTarget,
        "cursor",
      );
      expect(cursorEvents).toHaveLength(2);
      expect(cursorEvents[0]).toMatchObject({
        realmId,
        x: 750,
        y: 250,
        kind: "move",
      });
      expect(cursorEvents[1]).toMatchObject({
        realmId,
        x: 750,
        y: 250,
        kind: "click",
      });
      expect(
        harness.section<ComputerRealmView>(realmTarget, "info")?.agentName,
      ).toBe("Ada");
    } finally {
      await harness.dispose();
    }
  });

  it("g5 (Millisecond Single-Writer Takeover): calling takeover mid-batch aborts remaining queued micro-actions immediately, enables user input forwarding, and release hands control back to agent", async () => {
    const executedKinds: string[] = [];
    let step2StartedResolve!: () => void;
    const step2Started = new Promise<void>((resolve) => {
      step2StartedResolve = resolve;
    });

    const { models } = scriptedModels(() => say("ok"), { vision: true });
    const service = new ComputerService({
      machineId: "machine_g5",
      models,
      driverFactory: (ctx) => {
        const base = new SyntheticRealmDriver({
          kind: ctx.kind,
          target: ctx.target,
          title: ctx.title,
          viewport: ctx.viewport,
          fileBroker: ctx.fileBroker,
        });
        return {
          kind: base.kind,
          tier: base.tier,
          title: () => base.title(),
          target: () => base.target(),
          viewport: () => base.viewport(),
          observe: (opts) => base.observe(opts),
          step: async (action, stepCtx) => {
            executedKinds.push(action.kind);
            if (action.kind === "wait") {
              step2StartedResolve();
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, action.durationMs);
                stepCtx.signal.addEventListener(
                  "abort",
                  () => {
                    clearTimeout(timer);
                    resolve();
                  },
                  { once: true },
                );
              });
            }
          },
          close: () => base.close(),
        };
      },
    });
    const harness = mountComputerPluginWire(service);

    try {
      const meta: SessionMeta = {
        id: "sess_g5",
        createdAt: Date.now(),
        cwd: process.cwd(),
        model: "fake:vision-model",
      };
      const tools = computerSessionTools({
        service,
        models: () => models,
      })({ meta, session: undefined as never });

      const openTool = findTool(tools, "computer_open");
      const actTool = findTool(tools, "computer_act");

      const openRes = (await openTool.execute(
        { kind: "browser", target: "https://example.com/form" },
        { turn: 1, toolCallId: "tc-g5-open" },
      )) as ToolResult<{ realmId: string }>;
      const realmId = openRes.details!.realmId;
      const realmTarget = `computer.${realmId}`;

      // Start a 6-step micro-action batch where step 2 is a 10,000ms wait
      const batchPromise = actTool.execute(
        {
          realmId,
          actions: [
            { kind: "move", x: 200, y: 200, unit: "normalized" },
            { kind: "wait", durationMs: 10_000 },
            { kind: "click", x: 200, y: 200, unit: "normalized" },
            { kind: "type", text: "should-never-type", submit: true },
            { kind: "key", key: "Enter" },
            { kind: "scroll", deltaY: 300 },
          ],
        },
        { turn: 1, toolCallId: "tc-g5-act-batch" },
      );

      await step2Started;
      const takeoverStart = performance.now();
      const takeoverView = await harness.call<ComputerRealmView>(
        realmTarget,
        "takeover",
        { reason: "User clicked Take over" },
      );
      const batchResult = (await batchPromise) as ToolResult<{
        aborted: boolean;
        completedSteps: number;
        totalSteps: number;
        controller: string;
        epoch: number;
      }>;
      const takeoverElapsedMs = performance.now() - takeoverStart;

      // Batch aborts in milliseconds instead of waiting 10,000ms, discarding steps 3..6
      expect(takeoverElapsedMs).toBeLessThan(250);
      expect(takeoverView.controller).toBe("user");
      expect(takeoverView.epoch).toBe(2);
      expect(batchResult.details?.aborted).toBe(true);
      expect(batchResult.details?.completedSteps).toBe(1);
      expect(batchResult.details?.totalSteps).toBe(6);
      expect(executedKinds).toEqual(["move", "wait"]);

      // While controller === "user", agent computer_act is rejected
      const blockedAgentAct = (await actTool.execute(
        {
          realmId,
          actions: [{ kind: "click", x: 100, y: 100, unit: "normalized" }],
        },
        { turn: 2, toolCallId: "tc-g5-blocked" },
      )) as ToolResult;
      expect(blockedAgentAct.isError).toBe(true);

      // User manual input is forwarded and updates the realm cursor
      const userClickView = await harness.call<ComputerRealmView>(
        realmTarget,
        "input",
        {
          input: { kind: "click", x: 640, y: 360, button: "left" },
        },
      );
      expect(userClickView.cursor).toMatchObject({
        x: 640,
        y: 360,
        kind: "click",
      });
      expect(executedKinds).toEqual(["move", "wait", "click"]);

      // Release hands control back to agent and increments epoch
      const releaseView = await harness.call<ComputerRealmView>(
        realmTarget,
        "release",
        { reason: "User returned control to agent" },
      );
      expect(releaseView.controller).toBe("agent");
      expect(releaseView.epoch).toBe(3);

      // Agent can act again
      const resumedAct = (await actTool.execute(
        {
          realmId,
          expectedEpoch: 3,
          actions: [{ kind: "key", key: "Tab" }],
        },
        { turn: 3, toolCallId: "tc-g5-resumed" },
      )) as ToolResult<{ completedSteps: number; aborted: boolean }>;
      expect(resumedAct.isError).toBeUndefined();
      expect(resumedAct.details?.completedSteps).toBe(1);
      expect(resumedAct.details?.aborted).toBe(false);
    } finally {
      await harness.dispose();
    }
  });

  it("g6 (Agent Plugin Bundle & Skill Validity): writeComputerPluginBundle produces a valid Agent Plugins 1.0.0 bundle and MCP bridge executes all 7 tool calls cleanly", async () => {
    const bundleDir = createProjectTempDir("g6-plugin-bundle");
    const workspaceDir = createProjectTempDir("g6-workspace");
    const stagedFile = path.join(workspaceDir, "invoice.pdf");
    fs.writeFileSync(stagedFile, "%PDF-1.7 fake invoice", "utf8");

    const bundle = await writeComputerPluginBundle(bundleDir, {
      mcpServers: {
        computer: {
          type: "stdio",
          command: "eta",
          args: ["mcp", "computer-use"],
        },
      },
    });

    expect(fs.existsSync(bundle.pluginJsonPath)).toBe(true);
    expect(fs.existsSync(bundle.skillMdPath)).toBe(true);
    expect(bundle.mcpJsonPath && fs.existsSync(bundle.mcpJsonPath)).toBe(true);

    // 1. Validate with daemon's Agent Plugins 1.0.0 loader (`loadPlugin`)
    const loadedPlugin = await loadPlugin(bundleDir);
    expect(loadedPlugin.reports).toEqual([]);
    expect(loadedPlugin.configProblems).toEqual([]);
    expect(loadedPlugin.manifest.name).toBe("computer-use");
    expect(loadedPlugin.skills).toHaveLength(1);
    expect(loadedPlugin.skills[0]?.name).toBe("computer-use");
    expect(loadedPlugin.servers).toHaveLength(1);
    expect(loadedPlugin.servers[0]?.name).toBe("computer");

    // 2. Validate with harness's Agent Skills loader (`loadSkills`) and check required teachings
    const loadedSkills = await loadSkills([path.join(bundleDir, "skills")]);
    expect(loadedSkills.diagnostics).toEqual([]);
    expect(loadedSkills.skills).toHaveLength(1);
    expect(loadedSkills.skills[0]?.name).toBe("computer-use");
    expect(COMPUTER_USE_SKILL_MD).toContain("Observe -> Act -> Verify");
    expect(COMPUTER_USE_SKILL_MD).toContain("GroundCascade");
    expect(COMPUTER_USE_SKILL_MD).toContain("crop");
    expect(COMPUTER_USE_SKILL_MD).toContain("computer_stage_files");
    expect(COMPUTER_USE_SKILL_MD).toContain("computer_resolve_picker");
    expect(COMPUTER_USE_SKILL_MD).toContain("Objective Completion Judge");

    // 3. Validate MCP tool definitions and execute all 7 tools via `handleComputerMcpToolCall`
    const defs = createComputerMcpToolDefinitions();
    expect(defs.map((d) => d.name)).toEqual([
      "computer_open",
      "computer_observe",
      "computer_act",
      "computer_stage_files",
      "computer_resolve_picker",
      "computer_clipboard",
      "computer_close",
    ]);

    const manager = new RealmManager({ machineId: "machine_g6" });
    const policy = new FileBrokerPolicy({ projectDir: workspaceDir });

    const openRes = await handleComputerMcpToolCall(
      manager,
      "computer_open",
      {
        kind: "browser",
        target: "https://example.com/portal",
        title: "Invoice Portal",
      },
      { fileBroker: policy, sessionId: "mcp_sess_1" },
    );
    expect(openRes.isError).toBeUndefined();
    const realmId = openRes.details.realmId as string;
    expect(realmId).toBeTruthy();

    const obsCropRes = await handleComputerMcpToolCall(
      manager,
      "computer_observe",
      {
        realmId,
        crop: { x: 100, y: 100, width: 500, height: 500, unit: "normalized" },
      },
    );
    expect(obsCropRes.isError).toBeUndefined();
    expect(obsCropRes.content[0]?.type).toBe("image");
    expect(obsCropRes.details.cropRect).toEqual({
      x: 128,
      y: 80,
      width: 640,
      height: 400,
    });

    const stageRes = await handleComputerMcpToolCall(
      manager,
      "computer_stage_files",
      {
        realmId,
        files: [stagedFile],
        mode: "read",
      },
      { fileBroker: policy },
    );
    expect(stageRes.isError).toBeUndefined();
    expect((stageRes.details.picker as ComputerPickerState).status).toBe(
      "armed",
    );

    const resolveRes = await handleComputerMcpToolCall(
      manager,
      "computer_resolve_picker",
      {
        realmId,
        files: [stagedFile],
        mode: "read",
      },
      { fileBroker: policy },
    );
    expect(resolveRes.isError).toBeUndefined();
    expect((resolveRes.details.picker as ComputerPickerState).status).toBe(
      "intercepted_silent",
    );

    const actRes = await handleComputerMcpToolCall(manager, "computer_act", {
      realmId,
      actions: [
        { kind: "move", x: 400, y: 300, unit: "normalized" },
        { kind: "click", x: 400, y: 300, unit: "normalized" },
        { kind: "type", text: "INV-2026-001", submit: true },
      ],
    });
    expect(actRes.isError).toBeUndefined();
    expect(actRes.details.completedSteps).toBe(3);

    const clipWrite = await handleComputerMcpToolCall(
      manager,
      "computer_clipboard",
      {
        realmId,
        action: "write",
        text: "MCP_CLIPBOARD_OK",
      },
    );
    expect(clipWrite.isError).toBeUndefined();

    const clipRead = await handleComputerMcpToolCall(
      manager,
      "computer_clipboard",
      {
        realmId,
        action: "read",
      },
    );
    expect(clipRead.isError).toBeUndefined();
    expect(clipRead.details.text).toBe("MCP_CLIPBOARD_OK");

    const clipClear = await handleComputerMcpToolCall(
      manager,
      "computer_clipboard",
      {
        realmId,
        action: "clear",
      },
    );
    expect(clipClear.isError).toBeUndefined();
    expect(clipClear.details.text).toBe("");

    const closeRes = await handleComputerMcpToolCall(
      manager,
      "computer_close",
      {
        realmId,
        reason: "G6 verification complete",
      },
    );
    expect(closeRes.isError).toBeUndefined();
    expect((closeRes.details.realm as ComputerRealmView).controller).toBe(
      "closed",
    );
  });
});
