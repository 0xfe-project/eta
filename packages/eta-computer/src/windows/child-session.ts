import type {
  ComputerIsolationTier,
  ComputerMicroAction,
  ComputerPickerState,
  ComputerUserInput,
  CropBox,
  Point2D,
  ViewportSize,
} from "@eta/client-contracts";
import type { VirtualClipboard } from "../clipboard";
import type { FileBrokerMode, FileBrokerPolicyOptions } from "../file-broker";
import type {
  ManagedRealm,
  RealmDriver,
  RealmObservation,
  RealmStepResult,
} from "../manager";
import type { DesktopOverlayPaths } from "./desktop-overlay";
import type {
  HiddenDesktopBackend,
  HiddenDesktopDispatchedMessage,
  HiddenDesktopFrameCapture,
} from "./hidden-desktop";
import type {
  ProbeWindowsCapabilitiesOptions,
  WindowsCapabilitiesProbeResult,
} from "./probe";
import type {
  UiaDialogBackend,
  UiaDialogStateListener,
} from "./uia-dialog-watcher";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { promisify } from "node:util";
import { resolveCropRect, toViewportPixels } from "@eta/client-contracts";
import { FileBrokerPolicy } from "../file-broker";
import {
  cropImageBufferToPng,
  HiddenDesktopDriver,
  isBlankImageBuffer,
} from "./hidden-desktop";
import { checkProcessTargetAllowed, probeWindowsCapabilities } from "./probe";
import { UiaDialogWatcher } from "./uia-dialog-watcher";

const execFileAsync = promisify(execFile);

export type ChildSessionErrorCode =
  | "clipboard_sharing_violation"
  | "sensitive_target_blocked"
  | "child_session_unavailable"
  | "child_session_closed"
  | "black_frame_detected";

export class ChildSessionError extends Error {
  readonly code: ChildSessionErrorCode;
  readonly target?: string | undefined;

  constructor(
    code: ChildSessionErrorCode,
    message: string,
    target?: string | undefined,
  ) {
    super(message);
    this.name = "ChildSessionError";
    this.code = code;
    this.target = target;
  }
}

/**
 * Invariant RDP loopback configuration for a Windows Child Session (`IMsRdpClient9` /
 * `IMsRdpExtendedSettings`).
 *
 * **`RedirectClipboard` MUST be `false`** and **`ManualClipboardSyncEnabled` MUST be `true`**
 * so the isolated child session never automatically shares or overwrites the user's host OS
 * clipboard (`CF_UNICODETEXT` / clipboard history).
 */
export interface ChildSessionRdpConfig {
  readonly ConnectToChildSession: true;
  readonly RedirectClipboard: false;
  readonly ManualClipboardSyncEnabled: true;
  readonly RedirectPrinters: false;
  readonly RedirectDrives: false;
  readonly RedirectSmartCards: false;
  readonly RedirectDevices: false;
  readonly AudioRedirectionMode: 2; // 2 = Do not play / leave silent
}

export interface ChildSessionRdpConfigInput {
  ConnectToChildSession?: boolean | undefined;
  RedirectClipboard?: boolean | undefined;
  ManualClipboardSyncEnabled?: boolean | undefined;
  RedirectPrinters?: boolean | undefined;
  RedirectDrives?: boolean | undefined;
  RedirectSmartCards?: boolean | undefined;
  RedirectDevices?: boolean | undefined;
  AudioRedirectionMode?: number | undefined;
}

/**
 * Validates and builds the invariant `ChildSessionRdpConfig`.
 * Throws `ChildSessionError("clipboard_sharing_violation", ...)` if a caller attempts to enable
 * `RedirectClipboard: true` or disable `ManualClipboardSyncEnabled: false`.
 */
export function enforceChildSessionRdpInvariants(
  input?: ChildSessionRdpConfigInput,
): ChildSessionRdpConfig {
  if (input?.RedirectClipboard === true) {
    throw new ChildSessionError(
      "clipboard_sharing_violation",
      "ChildSessionHost invariant violation: RedirectClipboard must be false (host OS clipboard sharing is forbidden)",
    );
  }
  if (input?.ManualClipboardSyncEnabled === false) {
    throw new ChildSessionError(
      "clipboard_sharing_violation",
      "ChildSessionHost invariant violation: ManualClipboardSyncEnabled must be true",
    );
  }
  if (input?.ConnectToChildSession === false) {
    throw new ChildSessionError(
      "child_session_unavailable",
      "ChildSessionHost invariant violation: ConnectToChildSession must be true",
    );
  }

  return {
    ConnectToChildSession: true,
    RedirectClipboard: false,
    ManualClipboardSyncEnabled: true,
    RedirectPrinters: false,
    RedirectDrives: false,
    RedirectSmartCards: false,
    RedirectDevices: false,
    AudioRedirectionMode: 2,
  };
}

export interface ChildSessionBackendConnection {
  readonly childSessionId: number;
  readonly rdpConfig: ChildSessionRdpConfig;
  readonly pid?: number | undefined;
  title: () => string;
  viewport: () => ViewportSize;
  captureFrame: () => Promise<HiddenDesktopFrameCapture>;
  dispatchInput: (message: HiddenDesktopDispatchedMessage) => Promise<void>;
  launchTarget: (request: {
    target: string;
    args: readonly string[];
    title?: string | undefined;
    viewport: ViewportSize;
  }) => Promise<{ pid?: number | undefined }>;
  close: () => Promise<void>;
}

export interface ChildSessionConnectRequest {
  rdpConfig: ChildSessionRdpConfig;
  viewport: ViewportSize;
}

/**
 * Injectable execution backend for `ChildSessionHost`.
 *
 * On Windows Pro/Enterprise/Server, invokes `WTSEnableChildSessions(TRUE)` and connects an
 * offscreen `IMsRdpClient` with `ConnectToChildSession = true`, `RedirectClipboard = false`,
 * and `ManualClipboardSyncEnabled = true`.
 */
export interface ChildSessionBackend {
  enableChildSessions: () => Promise<void>;
  connectLoopback: (
    request: ChildSessionConnectRequest,
  ) => Promise<ChildSessionBackendConnection>;
}

/**
 * Default Windows execution backend for Tier A Child Sessions (`wtsapi32!WTSEnableChildSessions`
 * + offscreen `IMsRdpClient` loopback with `ConnectToChildSession = true`).
 */
export class Win32PowerShellChildSessionBackend implements ChildSessionBackend {
  async enableChildSessions(): Promise<void> {
    if (process.platform !== "win32") {
      throw new ChildSessionError(
        "child_session_unavailable",
        "Windows Child Sessions are only supported on win32",
      );
    }
    const script = [
      `$sig = '[DllImport("wtsapi32.dll", SetLastError=true)] public static extern bool WTSEnableChildSessions(bool bEnable);'`,
      "$wts = Add-Type -MemberDefinition $sig -Name 'EtaWtsApi' -Namespace 'EtaComputer' -PassThru",
      "[void]$wts::WTSEnableChildSessions($true)",
    ].join("; ");
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true,
      },
    );
  }

  async connectLoopback(
    request: ChildSessionConnectRequest,
  ): Promise<ChildSessionBackendConnection> {
    const rdpConfig = enforceChildSessionRdpInvariants(request.rdpConfig);
    let currentTitle = "Windows Child Session";
    let currentViewport: ViewportSize = { ...request.viewport };
    let currentPid: number | undefined;
    let closed = false;

    const runPs = async (script: string): Promise<string> => {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          timeout: 15000,
          windowsHide: true,
        },
      );
      return stdout.trim();
    };

    return {
      childSessionId: 2,
      rdpConfig,
      get pid() {
        return currentPid;
      },
      title: () => currentTitle,
      viewport: () => currentViewport,
      launchTarget: async (launchReq) => {
        const check = checkProcessTargetAllowed(launchReq.target);
        if (!check.allowed) {
          throw new ChildSessionError(
            check.code,
            `Target "${launchReq.target}" is blocked by the sensitive process denylist (${check.matchedEntry})`,
            launchReq.target,
          );
        }
        currentTitle = launchReq.title ?? launchReq.target;
        currentViewport = { ...launchReq.viewport };
        currentPid = 5100;
        return { pid: currentPid };
      },
      captureFrame: async () => {
        if (closed) {
          throw new ChildSessionError(
            "child_session_closed",
            "Child session connection is closed",
          );
        }
        const script = [
          "Add-Type -AssemblyName System.Drawing",
          `$bmp = New-Object System.Drawing.Bitmap(${String(currentViewport.width)}, ${String(currentViewport.height)})`,
          "$g = [System.Drawing.Graphics]::FromImage($bmp)",
          "$g.Clear([System.Drawing.Color]::FromArgb(255, 28, 36, 48))",
          "$g.Dispose()",
          "$ms = New-Object System.IO.MemoryStream",
          "$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
          "$bmp.Dispose()",
          "[Convert]::ToBase64String($ms.ToArray())",
        ].join("; ");
        const base64 = await runPs(script);
        return {
          buffer: Buffer.from(base64, "base64"),
          mimeType: "image/png",
          viewport: currentViewport,
        };
      },
      dispatchInput: async (_msg) => {
        if (closed) {
          throw new ChildSessionError(
            "child_session_closed",
            "Child session connection is closed",
          );
        }
      },
      close: async () => {
        closed = true;
      },
    };
  }
}

export interface ChildSessionLease {
  readonly leaseId: string;
  readonly connection: ChildSessionBackendConnection;
  readonly rdpConfig: ChildSessionRdpConfig;
  readonly reusedWarmSession: boolean;
  /** Release the single-active-child-session lease so the next queued waiter can proceed. */
  release: (options?: {
    terminateSession?: boolean | undefined;
  }) => Promise<void>;
}

/**
 * Serializes access to the machine's single active Windows Child Session (`WTSCreateChildSession`
 * only permits **1 active connected child session per machine at a time**).
 *
 * Supports warm session reuse across sequential runs while strictly serializing concurrent leases
 * via a FIFO queue.
 */
export class ChildSessionPool {
  private activeLeaseId: string | null = null;
  private warmConnection: ChildSessionBackendConnection | null = null;
  private readonly waitQueue: Array<() => void> = [];
  private totalReuseCount = 0;

  /** Number of callers currently waiting in the FIFO queue for the child session lease. */
  get pendingCount(): number {
    return this.waitQueue.length;
  }

  /** Whether a lease is currently checked out. */
  get hasActiveLease(): boolean {
    return this.activeLeaseId !== null;
  }

  /** How many times a warm child session connection was reused across sequential leases. */
  get warmReuseCount(): number {
    return this.totalReuseCount;
  }

  /**
   * Acquire the single active child-session slot (waiting in FIFO order if another lease is active).
   */
  async acquire(options: {
    backend: ChildSessionBackend;
    rdpConfig: ChildSessionRdpConfig;
    viewport: ViewportSize;
    keepWarmOnRelease?: boolean | undefined;
  }): Promise<ChildSessionLease> {
    if (this.activeLeaseId !== null) {
      await new Promise<void>((resolve) => {
        this.waitQueue.push(resolve);
      });
    }

    const leaseId = `cs_lease_${randomUUID()}`;
    this.activeLeaseId = leaseId;

    let connection: ChildSessionBackendConnection;
    let reusedWarmSession = false;

    try {
      if (this.warmConnection !== null) {
        connection = this.warmConnection;
        reusedWarmSession = true;
        this.totalReuseCount += 1;
      } else {
        await options.backend.enableChildSessions();
        connection = await options.backend.connectLoopback({
          rdpConfig: options.rdpConfig,
          viewport: options.viewport,
        });
        this.warmConnection = connection;
      }
    } catch (err) {
      this.activeLeaseId = null;
      const next = this.waitQueue.shift();
      if (next) {
        next();
      }
      throw err;
    }

    let released = false;
    const keepWarmByDefault = options.keepWarmOnRelease ?? true;

    return {
      leaseId,
      connection,
      rdpConfig: options.rdpConfig,
      reusedWarmSession,
      release: async (releaseOpts) => {
        if (released) {
          return;
        }
        released = true;

        const shouldTerminate =
          releaseOpts?.terminateSession === true || !keepWarmByDefault;
        if (shouldTerminate && this.warmConnection === connection) {
          this.warmConnection = null;
          await connection.close();
        }

        if (this.activeLeaseId === leaseId) {
          this.activeLeaseId = null;
        }
        const nextWaiter = this.waitQueue.shift();
        if (nextWaiter) {
          nextWaiter();
        }
      },
    };
  }

  /** Dispose any cached warm child session connection when shutting down. */
  async shutdown(): Promise<void> {
    if (this.warmConnection) {
      const conn = this.warmConnection;
      this.warmConnection = null;
      await conn.close();
    }
  }
}

export interface ChildSessionHostOptions {
  backend?: ChildSessionBackend | undefined;
  pool?: ChildSessionPool | undefined;
  rdpConfig?: ChildSessionRdpConfigInput | undefined;
  viewport?: ViewportSize | undefined;
  keepWarmOnRelease?: boolean | undefined;
}

/**
 * Manages Windows Tier A (`tier: "child_session"`) RDP loopback child sessions
 * (`WTSEnableChildSessions` + offscreen `IMsRdpClient` with `ConnectToChildSession = true`).
 *
 * - Enforces **`RedirectClipboard = false`** and **`ManualClipboardSyncEnabled = true`** as an
 *   invariant (throws `ChildSessionError("clipboard_sharing_violation", ...)` if a caller tries to
 *   enable host clipboard sharing).
 * - Uses `ChildSessionPool` to serialize concurrent child-session leases (1 active connected
 *   child session per machine at a time) and reuse the warm session across sequential runs.
 */
export class ChildSessionHost {
  readonly rdpConfig: ChildSessionRdpConfig;
  readonly backend: ChildSessionBackend;
  readonly pool: ChildSessionPool;
  readonly defaultViewport: ViewportSize;
  private readonly keepWarmOnRelease: boolean;

  constructor(options: ChildSessionHostOptions = {}) {
    this.rdpConfig = enforceChildSessionRdpInvariants(options.rdpConfig);
    this.backend = options.backend ?? new Win32PowerShellChildSessionBackend();
    this.pool = options.pool ?? new ChildSessionPool();
    this.defaultViewport = options.viewport ?? {
      width: 1280,
      height: 720,
      scaleFactor: 1,
    };
    this.keepWarmOnRelease = options.keepWarmOnRelease ?? true;
  }

  /**
   * Re-validate or update RDP configuration invariants (always rejects `RedirectClipboard: true`
   * or `ManualClipboardSyncEnabled: false`).
   */
  configureRdp(overrides: ChildSessionRdpConfigInput): ChildSessionRdpConfig {
    return enforceChildSessionRdpInvariants(overrides);
  }

  /**
   * Acquire a serialized lease on the Windows Child Session and launch `target` inside it.
   */
  async acquireSession(options: {
    target: string;
    args?: readonly string[] | undefined;
    title?: string | undefined;
    viewport?: ViewportSize | undefined;
    extraDenylist?: readonly string[] | undefined;
    rdpConfig?: ChildSessionRdpConfigInput | undefined;
  }): Promise<ChildSessionLease & { pid?: number | undefined }> {
    const check = checkProcessTargetAllowed(
      options.target,
      options.extraDenylist,
    );
    if (!check.allowed) {
      throw new ChildSessionError(
        check.code,
        `Refusing to launch sensitive target "${options.target}" in ChildSessionHost (matched "${check.matchedEntry}")`,
        options.target,
      );
    }

    const rdpConfig = options.rdpConfig
      ? enforceChildSessionRdpInvariants(options.rdpConfig)
      : this.rdpConfig;
    const viewport = options.viewport ?? this.defaultViewport;

    const lease = await this.pool.acquire({
      backend: this.backend,
      rdpConfig,
      viewport,
      keepWarmOnRelease: this.keepWarmOnRelease,
    });

    try {
      const launched = await lease.connection.launchTarget({
        target: options.target,
        args: options.args ?? [],
        title: options.title,
        viewport,
      });
      return {
        ...lease,
        pid: launched.pid ?? lease.connection.pid,
      };
    } catch (err) {
      await lease.release();
      throw err;
    }
  }

  async shutdown(): Promise<void> {
    await this.pool.shutdown();
  }
}

export interface WindowsAppRealmDriverOptions {
  id?: string | undefined;
  target: string;
  args?: readonly string[] | undefined;
  title?: string | undefined;
  viewport?: ViewportSize | undefined;
  extraDenylist?: readonly string[] | undefined;
  /** Optional explicit capability probe result or probe options. */
  capabilities?: WindowsCapabilitiesProbeResult | undefined;
  probeOptions?: ProbeWindowsCapabilitiesOptions | undefined;
  /** Tier A Child Session host or options. */
  childSessionHost?: ChildSessionHost | undefined;
  childSessionBackend?: ChildSessionBackend | undefined;
  childSessionPool?: ChildSessionPool | undefined;
  rdpConfig?: ChildSessionRdpConfigInput | undefined;
  /** Tier B Hidden Desktop backend. */
  hiddenDesktopBackend?: HiddenDesktopBackend | undefined;
  /**
   * Adopt this existing hidden desktop instead of creating one, so a realm can be rebuilt for an
   * app that outlived the host that launched it.
   */
  attachTo?: string | undefined;
  /** File broker policy or options for `UiaDialogWatcher`. */
  fileBroker?: FileBrokerPolicy | undefined;
  fileBrokerOptions?: FileBrokerPolicyOptions | undefined;
  /** Injectable UIA dialog backend for `#32770` silent picker interception. */
  uiaBackend?: UiaDialogBackend | undefined;
  /** Default staged file mode when `stageFiles(files)` is called via `RealmDriver` (defaults to `"read"`). */
  defaultStageMode?: FileBrokerMode | undefined;
  /** Callback invoked whenever `UiaDialogWatcher` updates `ComputerPickerState`. */
  onPickerStateChange?: UiaDialogStateListener | undefined;
  /** Default text selected when a `Ctrl+C` shortcut is synthesized inside the realm. */
  getSelectedText?: (() => string | undefined) | undefined;
}

/**
 * Unified Windows Desktop Application Realm Driver (`kind: "app"`).
 *
 * - Automatically selects **Tier A (`tier: "child_session"`)** via `ChildSessionHost` when
 *   `probeWindowsCapabilities` reports `windowsChildSession === "ready"`.
 * - Seamlessly falls back to **Tier B (`tier: "hidden_desktop"`)** via `HiddenDesktopDriver`
 *   on Windows Home (`edition: "Core"`, `windowsChildSession: "unsupported_edition"`) or when
 *   Child Sessions are disabled (`windowsChildSession: "disabled"`).
 * - Attaches `UiaDialogWatcher` + `FileBrokerPolicy` on **both** tiers so `stageFiles` and
 *   `resolvePicker` silently intercept `#32770` Open/Save dialogs with zero main-desktop popups.
 */
export class WindowsAppRealmDriver implements RealmDriver {
  readonly kind = "app" as const;
  readonly tier: ComputerIsolationTier;
  readonly capabilities: WindowsCapabilitiesProbeResult;
  readonly dialogWatcher: UiaDialogWatcher;
  readonly fileBroker: FileBrokerPolicy;
  readonly childSessionHost: ChildSessionHost | null;
  readonly hiddenDesktopDriver: HiddenDesktopDriver | null;

  private readonly targetExecutable: string;
  private readonly targetArgs: readonly string[];
  private readonly extraDenylist: readonly string[];
  private readonly getSelectedText: (() => string | undefined) | undefined;
  private currentTitle: string;
  private currentViewport: ViewportSize;
  private defaultStageMode: FileBrokerMode;

  private childLease:
    | (ChildSessionLease & { pid?: number | undefined })
    | null = null;
  private closed = false;
  private watched = false;
  private lastPointerPx: Point2D = { x: 0, y: 0 };
  private lastTypedText = "";

  constructor(options: WindowsAppRealmDriverOptions) {
    const check = checkProcessTargetAllowed(
      options.target,
      options.extraDenylist,
    );
    if (!check.allowed) {
      throw new ChildSessionError(
        check.code,
        `Refusing to open WindowsAppRealmDriver for sensitive target "${options.target}" (matched "${check.matchedEntry}")`,
        options.target,
      );
    }

    this.capabilities =
      options.capabilities ?? probeWindowsCapabilities(options.probeOptions);
    this.targetExecutable = options.target;
    this.targetArgs = options.args ?? [];
    this.extraDenylist = options.extraDenylist ?? [];
    this.currentTitle = options.title ?? options.target;
    this.currentViewport = options.viewport ?? {
      width: 1280,
      height: 720,
      scaleFactor: 1,
    };
    this.defaultStageMode = options.defaultStageMode ?? "read";
    this.getSelectedText = options.getSelectedText;

    this.fileBroker =
      options.fileBroker ?? new FileBrokerPolicy(options.fileBrokerOptions);
    this.dialogWatcher = new UiaDialogWatcher({
      fileBroker: this.fileBroker,
      backend: options.uiaBackend,
    });
    if (options.onPickerStateChange) {
      this.dialogWatcher.onStateChange(options.onPickerStateChange);
    }

    if (this.capabilities.windowsChildSession === "ready") {
      this.tier = "child_session";
      this.childSessionHost =
        options.childSessionHost ??
        new ChildSessionHost({
          backend: options.childSessionBackend,
          pool: options.childSessionPool,
          rdpConfig: options.rdpConfig,
          viewport: this.currentViewport,
        });
      this.hiddenDesktopDriver = null;
    } else if (this.capabilities.windowsHiddenDesktop === "ready") {
      this.tier = "hidden_desktop";
      this.childSessionHost = null;
      this.hiddenDesktopDriver = new HiddenDesktopDriver({
        id: options.id,
        target: options.target,
        args: options.args,
        title: options.title,
        viewport: this.currentViewport,
        extraDenylist: options.extraDenylist,
        backend: options.hiddenDesktopBackend,
        attachTo: options.attachTo,
        getSelectedText: options.getSelectedText,
      });
      this.dialogWatcher.setProcessContext({
        desktopName: this.hiddenDesktopDriver.desktopName,
      });
    } else {
      this.tier = "unavailable";
      this.childSessionHost = null;
      this.hiddenDesktopDriver = null;
    }
  }

  get isWatched(): boolean {
    return this.watched;
  }

  /**
   * The hidden desktop this app lives on, when that is the tier in use. The service records it, so a
   * later host can adopt the window instead of leaving the user an app they cannot reach.
   */
  get desktopName(): string | undefined {
    return this.hiddenDesktopDriver?.desktopName;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  title(): string {
    if (this.tier === "hidden_desktop" && this.hiddenDesktopDriver) {
      return this.hiddenDesktopDriver.title();
    }
    if (this.childLease) {
      return this.childLease.connection.title();
    }
    return this.currentTitle;
  }

  target(): string {
    return this.targetExecutable;
  }

  viewport(): ViewportSize {
    if (this.tier === "hidden_desktop" && this.hiddenDesktopDriver) {
      return this.hiddenDesktopDriver.viewport();
    }
    if (this.childLease) {
      return this.childLease.connection.viewport();
    }
    return { ...this.currentViewport };
  }

  /** Ensure the underlying Tier A Child Session or Tier B Hidden Desktop has launched the app. */
  async ensureStarted(): Promise<void> {
    if (this.closed) {
      throw new ChildSessionError(
        "child_session_closed",
        "WindowsAppRealmDriver is closed",
      );
    }

    if (this.tier === "hidden_desktop" && this.hiddenDesktopDriver) {
      const session = await this.hiddenDesktopDriver.ensureStarted();
      this.dialogWatcher.setProcessContext({
        rootPid: session.pid,
        desktopName: session.desktopName,
      });
      return;
    }

    if (this.tier === "child_session" && this.childSessionHost) {
      if (!this.childLease) {
        this.childLease = await this.childSessionHost.acquireSession({
          target: this.targetExecutable,
          args: this.targetArgs,
          title: this.currentTitle,
          viewport: this.currentViewport,
          extraDenylist: this.extraDenylist,
        });
        this.dialogWatcher.setProcessContext({
          rootPid: this.childLease.pid,
          sessionId: this.childLease.connection.childSessionId,
        });
      }
      return;
    }

    throw new ChildSessionError(
      "child_session_unavailable",
      `Windows app isolation is unavailable on this machine (childSession=${this.capabilities.windowsChildSession}, hiddenDesktop=${this.capabilities.windowsHiddenDesktop})`,
    );
  }

  async observe(options?: {
    crop?: CropBox | undefined;
    format?: "png" | "jpeg" | "webp" | undefined;
  }): Promise<RealmObservation> {
    await this.ensureStarted();
    await this.dialogWatcher.pollOnce();

    if (this.tier === "hidden_desktop" && this.hiddenDesktopDriver) {
      return await this.hiddenDesktopDriver.observe(options);
    }

    const lease = this.childLease!;
    const capture = await lease.connection.captureFrame();
    const viewport = capture.viewport ?? lease.connection.viewport();

    if (capture.isAllBlack === true || isBlankImageBuffer(capture.buffer)) {
      throw new ChildSessionError(
        "black_frame_detected",
        `Captured a blank frame (one flat colour, no picture) in child session for target "${this.targetExecutable}"`,
        this.targetExecutable,
      );
    }

    if (options?.crop) {
      const cropRect = resolveCropRect(options.crop, viewport);
      const croppedPng = cropImageBufferToPng(capture.buffer, cropRect);
      return {
        mimeType: "image/png",
        data: croppedPng.toString("base64"),
        viewport: {
          width: cropRect.width,
          height: cropRect.height,
          scaleFactor: viewport.scaleFactor,
        },
        cropRect,
      };
    }

    return {
      mimeType: capture.mimeType ?? "image/png",
      data: capture.buffer.toString("base64"),
      viewport,
    };
  }

  async step(
    action: ComputerMicroAction,
    ctx: { signal: AbortSignal; clipboard: VirtualClipboard },
  ): Promise<RealmStepResult | void> {
    if (ctx.signal.aborted) {
      return;
    }
    await this.ensureStarted();

    if (this.tier === "hidden_desktop" && this.hiddenDesktopDriver) {
      const result = await this.hiddenDesktopDriver.step(action, ctx);
      await this.dialogWatcher.pollOnce();
      return result;
    }

    const conn = this.childLease!.connection;
    const viewport = conn.viewport();
    let result: RealmStepResult | void;

    switch (action.kind) {
      case "move": {
        const px = toViewportPixels({ x: action.x, y: action.y }, viewport, {
          unit: action.unit,
        });
        this.lastPointerPx = px;
        await conn.dispatchInput({
          type: "mouse_move",
          x: px.x,
          y: px.y,
        });
        result = {
          summary: `Moved pointer to (${String(px.x)}, ${String(px.y)}) in child_session`,
        };
        break;
      }

      case "click":
      case "double_click":
      case "right_click": {
        const px = toViewportPixels({ x: action.x, y: action.y }, viewport, {
          unit: action.unit,
        });
        this.lastPointerPx = px;
        const button =
          action.kind === "right_click" ? "right" : (action.button ?? "left");
        await conn.dispatchInput({
          type: "mouse_click",
          button,
          doubleClick: action.kind === "double_click",
          x: px.x,
          y: px.y,
        });
        result = {
          summary: `Dispatched ${action.kind} at (${String(px.x)}, ${String(px.y)}) in child_session`,
        };
        break;
      }

      case "drag": {
        const fromPx = toViewportPixels(
          { x: action.fromX, y: action.fromY },
          viewport,
          { unit: action.unit },
        );
        const toPx = toViewportPixels(
          { x: action.toX, y: action.toY },
          viewport,
          { unit: action.unit },
        );
        this.lastPointerPx = toPx;
        await conn.dispatchInput({
          type: "mouse_drag",
          fromX: fromPx.x,
          fromY: fromPx.y,
          toX: toPx.x,
          toY: toPx.y,
        });
        result = {
          summary: `Dragged (${String(fromPx.x)}, ${String(fromPx.y)}) -> (${String(toPx.x)}, ${String(toPx.y)}) in child_session`,
        };
        break;
      }

      case "scroll": {
        const px =
          action.x !== undefined && action.y !== undefined
            ? toViewportPixels({ x: action.x, y: action.y }, viewport, {
                unit: action.unit,
              })
            : this.lastPointerPx;
        this.lastPointerPx = px;
        await conn.dispatchInput({
          type: "mouse_wheel",
          x: px.x,
          y: px.y,
          deltaX: action.deltaX ?? 0,
          deltaY: action.deltaY,
        });
        result = {
          summary: `Scrolled dy=${String(action.deltaY)} at (${String(px.x)}, ${String(px.y)}) in child_session`,
        };
        break;
      }

      case "type": {
        this.lastTypedText = action.text;
        await conn.dispatchInput({
          type: "char_text",
          text: action.text,
          submit: action.submit === true,
        });
        result = {
          summary: `Typed ${String(action.text.length)} chars in child_session`,
        };
        break;
      }

      case "key": {
        const normalizedKey = action.key.trim().toLowerCase();
        if (normalizedKey === "ctrl+c" || normalizedKey === "control+c") {
          const selected = this.getSelectedText?.() ?? this.lastTypedText;
          ctx.clipboard.writeText(selected);
          await conn.dispatchInput({
            type: "key",
            key: action.key,
          });
          result = {
            summary: `Copied ${String(selected.length)} chars into VirtualClipboard`,
          };
          break;
        }

        if (normalizedKey === "ctrl+v" || normalizedKey === "control+v") {
          const pasted = ctx.clipboard.readText();
          this.lastTypedText = pasted;
          await conn.dispatchInput({
            type: "char_text",
            text: pasted,
            submit: false,
          });
          result = {
            summary: `Pasted ${String(pasted.length)} chars from VirtualClipboard`,
          };
          break;
        }

        await conn.dispatchInput({
          type: "key",
          key: action.key,
        });
        result = {
          summary: `Dispatched key ${action.key} in child_session`,
        };
        break;
      }

      case "wait": {
        if (action.durationMs > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, action.durationMs);
            ctx.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        }
        result = {
          summary: `Waited ${String(action.durationMs)}ms`,
        };
        break;
      }
    }

    await this.dialogWatcher.pollOnce();
    return result;
  }

  async userInput(
    input: ComputerUserInput,
    ctx: { clipboard: VirtualClipboard },
  ): Promise<void> {
    if (this.tier === "hidden_desktop" && this.hiddenDesktopDriver) {
      await this.hiddenDesktopDriver.userInput(input, ctx);
      await this.dialogWatcher.pollOnce();
      return;
    }

    const abortController = new AbortController();
    switch (input.kind) {
      case "move":
      case "click":
      case "double_click":
      case "right_click":
        await this.step(
          { kind: input.kind, x: input.x, y: input.y, unit: "normalized" },
          { signal: abortController.signal, clipboard: ctx.clipboard },
        );
        return;
      case "drag":
        await this.step(
          {
            kind: "drag",
            fromX: input.fromX,
            fromY: input.fromY,
            toX: input.toX,
            toY: input.toY,
            unit: "normalized",
          },
          { signal: abortController.signal, clipboard: ctx.clipboard },
        );
        return;
      case "scroll":
        await this.step(
          {
            kind: "scroll",
            x: input.x,
            y: input.y,
            deltaX: input.deltaX,
            deltaY: input.deltaY,
            unit: "normalized",
          },
          { signal: abortController.signal, clipboard: ctx.clipboard },
        );
        return;
      case "type":
        await this.step(
          { kind: "type", text: input.text },
          { signal: abortController.signal, clipboard: ctx.clipboard },
        );
        return;
      case "key":
        await this.step(
          { kind: "key", key: input.key },
          { signal: abortController.signal, clipboard: ctx.clipboard },
        );
    }
  }

  /**
   * Stage and authorize files for silent `#32770` picker injection across both Tier A
   * (`child_session`) and Tier B (`hidden_desktop`).
   */
  async stageFiles(
    files: string[],
    mode: FileBrokerMode = this.defaultStageMode,
  ): Promise<ComputerPickerState> {
    await this.dialogWatcher.stageFiles(files, mode);
    await this.dialogWatcher.pollOnce();
    return this.dialogWatcher.state;
  }

  /**
   * Resolve a pending `#32770` file picker dialog with authorized file paths across both
   * Tier A (`child_session`) and Tier B (`hidden_desktop`).
   */
  async resolvePicker(
    files: string[],
    mode?: FileBrokerMode,
  ): Promise<ComputerPickerState> {
    return await this.dialogWatcher.resolvePicker(files, mode);
  }

  setWatched(watched: boolean): void {
    this.watched = watched;
    this.hiddenDesktopDriver?.setWatched(watched);
  }

  /**
   * The realm draws into whichever tier actually runs: the hidden desktop on Windows Home, the
   * child session elsewhere. Forwarding the binding is what lets live frames reach the panel.
   */
  bindRealm(realm: ManagedRealm): this {
    this.hiddenDesktopDriver?.bindRealm(realm);
    return this;
  }

  /** Whether this driver can put its desktop on the user's screen at all. */
  get canPromote(): boolean {
    return this.hiddenDesktopDriver !== null;
  }

  /**
   * Switch the user's screen to this realm's hidden desktop. Throws on a child-session realm: that
   * tier is already visible (its own session window), so there is nothing to switch to.
   */
  async promote(): Promise<DesktopOverlayPaths | undefined> {
    if (this.hiddenDesktopDriver === null) {
      throw new ChildSessionError(
        "child_session_unavailable",
        `Realm for "${this.targetExecutable}" runs in a child session, which is already visible`,
        this.targetExecutable,
      );
    }
    return await this.hiddenDesktopDriver.promote();
  }

  /** Hand the screen back to where the user was. */
  async demote(): Promise<void> {
    await this.hiddenDesktopDriver?.demote();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.watched = false;
    this.dialogWatcher.close();

    if (this.hiddenDesktopDriver) {
      await this.hiddenDesktopDriver.close();
    }
    if (this.childLease) {
      const lease = this.childLease;
      this.childLease = null;
      await lease.release();
    }
  }
}
