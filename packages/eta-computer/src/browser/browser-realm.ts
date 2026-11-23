import type {
  ComputerFrameEvent,
  ComputerMicroAction,
  ComputerPickerMode,
  ComputerPickerState,
  ComputerUserInput,
  CropBox,
  Point2D,
  ViewportSize,
} from "@eta/client-contracts";
import type {
  ManagedRealm,
  RealmDriver,
  RealmObservation,
  RealmStepResult,
} from "../manager";
import type {
  CdpPipeLaunchOptions,
  CdpSendOptions,
  CdpTransport,
} from "./cdp-pipe";
import path from "node:path";
import process from "node:process";
import { resolveCropRect, toViewportPixels } from "@eta/client-contracts";
import { VirtualClipboard } from "../clipboard";
import { FileBrokerPolicy } from "../file-broker";
import { launchCdpConnection } from "./cdp-pipe";

export const DEFAULT_BROWSER_VIEWPORT: ViewportSize = {
  width: 1280,
  height: 800,
  scaleFactor: 1,
};

export interface BrowserRealmOptions {
  /** CDP transport (e.g., `CdpPipeConnection` or an injected test transport). */
  transport: CdpTransport;
  /** Optional pre-attached CDP page `sessionId`. Auto-discovered on `attach()` if omitted. */
  sessionId?: string | undefined;
  /** Realm identifier included in emitted `ComputerFrameEvent` payloads. */
  realmId?: string | undefined;
  /** Viewport dimensions (default: `1280x800`, `scaleFactor: 1`). */
  viewport?: ViewportSize | undefined;
  /** Initial URL tracked before navigation (default: `"about:blank"`). */
  initialUrl?: string | undefined;
  /** Initial document title (default: `""`). */
  initialTitle?: string | undefined;
  /** Directory where silent downloads are written via `Browser.setDownloadBehavior`. */
  downloadPath?: string | undefined;
  /** File broker policy used to authorize `stageFiles` and `resolvePicker` paths. */
  fileBroker?: FileBrokerPolicy | undefined;
  /** Warm-on-subscribe screencast frame rate in FPS (clamped to `2..6`, default `4`). */
  screencastFps?: number | undefined;
  /** Format used for warm-on-subscribe screencast frames (default `"jpeg"`). */
  screencastFormat?: "jpeg" | "png" | "webp" | undefined;
  /** Callback invoked when a clean frame is captured while `watched === true`. */
  onFrame?: ((frame: ComputerFrameEvent) => void) | undefined;
  /** Callback invoked whenever the silent file picker state changes. */
  onPickerChange?: ((state: ComputerPickerState) => void) | undefined;
  /** Short settle window (ms) after mouse clicks to catch async `Page.fileChooserOpened` events. */
  clickSettleMs?: number | undefined;
}

export interface BrowserRealmLaunchOptions
  extends Omit<BrowserRealmOptions, "transport">,
    CdpPipeLaunchOptions {}

interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  text?: string | undefined;
}

const SPECIAL_KEY_MAP: Record<string, KeyDefinition> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

function clampScreencastFps(fps: number | undefined): number {
  if (fps === undefined || !Number.isFinite(fps)) return 4;
  if (fps < 2) return 2;
  if (fps > 6) return 6;
  return fps;
}

function parseKeyChord(chord: string): {
  modifiers: number;
  controlOrMeta: boolean;
  shift: boolean;
  alt: boolean;
  primaryKey: string;
} {
  const parts = chord
    .split("+")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  let modifiers = 0;
  let controlOrMeta = false;
  let shift = false;
  let alt = false;
  const primaryKey = parts[parts.length - 1] ?? chord;

  for (let i = 0; i < parts.length - 1; i += 1) {
    const mod = (parts[i] ?? "").toLowerCase();
    if (mod === "alt" || mod === "option") {
      modifiers |= 1;
      alt = true;
    } else if (mod === "control" || mod === "ctrl") {
      modifiers |= 2;
      controlOrMeta = true;
    } else if (
      mod === "meta" ||
      mod === "cmd" ||
      mod === "command" ||
      mod === "win" ||
      mod === "super"
    ) {
      modifiers |= 4;
      controlOrMeta = true;
    } else if (mod === "shift") {
      modifiers |= 8;
      shift = true;
    }
  }

  return { modifiers, controlOrMeta, shift, alt, primaryKey };
}

function resolveKeyDefinition(rawKey: string): KeyDefinition {
  const lower = rawKey.toLowerCase();
  const special = SPECIAL_KEY_MAP[lower];
  if (special) {
    return special;
  }
  if (rawKey.length === 1) {
    const upper = rawKey.toUpperCase();
    const charCode = upper.charCodeAt(0);
    const isLetter = charCode >= 65 && charCode <= 90;
    const isDigit = charCode >= 48 && charCode <= 57;
    return {
      key: rawKey,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${rawKey}` : rawKey,
      keyCode: charCode,
      text: rawKey,
    };
  }
  return {
    key: rawKey,
    code: rawKey,
    keyCode: 0,
  };
}

function abortableSleep(
  durationMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (durationMs <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Isolated headless Chromium realm driver (`kind: "browser"`, `tier: "cdp"`).
 *
 * - Communicates over CDP (`CdpPipeConnection` or injected `CdpTransport`).
 * - Synthesizes mouse & keyboard events, intercepting `Control+c` / `Meta+c` and `Control+v` / `Meta+v`
 *   into the realm's isolated `VirtualClipboard` without ever touching the host OS clipboard.
 * - Captures clean screenshots (`fromSurface: true`, never painting a synthetic cursor) with
 *   optional `GroundCascade` `CropBox` `clip` rectangles.
 * - Implements `T5` Silent File Picker & Download Broker (`Page.setInterceptFileChooserDialog` +
 *   `DOM.setFileInputFiles` + `FileBrokerPolicy` validation) so `<input type="file">` never opens a
 *   blocking native `comdlg32` dialog.
 */
export class BrowserRealmDriver implements RealmDriver {
  readonly kind = "browser" as const;
  readonly tier = "cdp" as const;
  readonly transport: CdpTransport;
  readonly fileBroker: FileBrokerPolicy;
  readonly downloadPath: string;

  private sessionId: string | undefined;
  private realmId: string;
  private currentViewport: ViewportSize;
  private currentUrl: string;
  private currentTitle: string;
  private lastPointerPx: Point2D;
  private readonly screencastFps: number;
  private readonly screencastFormat: "jpeg" | "png" | "webp";
  private readonly clickSettleMs: number;
  private readonly fallbackClipboard = new VirtualClipboard();

  private onFrameCallback: ((frame: ComputerFrameEvent) => void) | undefined;
  private onPickerChangeCallback:
    | ((state: ComputerPickerState) => void)
    | undefined;
  private readonly unsubscribeEvents: Array<() => void> = [];

  private attached = false;
  private closed = false;
  private watched = false;
  private screencastSeq = 0;
  private screencastTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;

  private stagedFiles: string[] = [];
  private pendingBackendNodeId: number | undefined;
  private pendingPickerMode: ComputerPickerMode | undefined;
  private currentPicker: ComputerPickerState;
  private inFlightFileChooserTask: Promise<void> | null = null;

  private stepModalOrNavTriggered = false;

  constructor(options: BrowserRealmOptions) {
    this.transport = options.transport;
    this.sessionId = options.sessionId;
    this.realmId = options.realmId ?? "browser";
    this.currentViewport = {
      width: options.viewport?.width ?? DEFAULT_BROWSER_VIEWPORT.width,
      height: options.viewport?.height ?? DEFAULT_BROWSER_VIEWPORT.height,
      scaleFactor:
        options.viewport?.scaleFactor ?? DEFAULT_BROWSER_VIEWPORT.scaleFactor,
    };
    this.currentUrl = options.initialUrl ?? "about:blank";
    this.currentTitle = options.initialTitle ?? "";
    this.lastPointerPx = {
      x: Math.round(this.currentViewport.width / 2),
      y: Math.round(this.currentViewport.height / 2),
    };
    this.downloadPath =
      options.downloadPath ??
      path.join(process.cwd(), ".eta-browser-downloads");
    this.fileBroker =
      options.fileBroker ??
      new FileBrokerPolicy({
        projectDir: process.cwd(),
        stagingDir: this.downloadPath,
      });
    this.screencastFps = clampScreencastFps(options.screencastFps);
    this.screencastFormat = options.screencastFormat ?? "jpeg";
    this.clickSettleMs = options.clickSettleMs ?? 20;
    this.onFrameCallback = options.onFrame;
    this.onPickerChangeCallback = options.onPickerChange;
    this.currentPicker = {
      status: "idle",
      files: [],
      updatedAt: Date.now(),
    };

    this.registerEventListeners();
  }

  /**
   * Launch a local Chromium process over `--remote-debugging-pipe`, attach a `BrowserRealmDriver`,
   * configure viewport and silent file picker interception, and optionally navigate to `initialUrl`.
   */
  static async launch(
    options: BrowserRealmLaunchOptions = {},
  ): Promise<BrowserRealmDriver> {
    const connection = await launchCdpConnection({
      executablePath: options.executablePath,
      transport: options.transport,
      userDataDir: options.userDataDir,
      profileBaseDir: options.profileBaseDir,
      cleanupUserDataDir: options.cleanupUserDataDir,
      initialUrl: "about:blank",
      extraArgs: options.extraArgs,
      defaultTimeoutMs: options.defaultTimeoutMs,
      env: options.env,
    });

    const driver = new BrowserRealmDriver({
      ...options,
      transport: connection,
    });

    try {
      await driver.attach();
      if (options.initialUrl && options.initialUrl !== "about:blank") {
        await driver.navigate(options.initialUrl);
      }
      return driver;
    } catch (err) {
      await connection.close();
      throw err;
    }
  }

  /**
   * Bind a `ManagedRealm` so frame broadcasts and asynchronous silent picker transitions automatically
   * propagate into the realm's state and watchers.
   */
  bindRealm(realm: ManagedRealm): this {
    this.realmId = realm.id;
    const prevFrame = this.onFrameCallback;
    const prevPicker = this.onPickerChangeCallback;

    this.onFrameCallback = (frame) => {
      prevFrame?.(frame);
      realm.emitFrame({
        mimeType: frame.mimeType,
        data: frame.data,
        viewport: frame.viewport,
        at: frame.at,
      });
    };

    this.onPickerChangeCallback = (state) => {
      prevPicker?.(state);
      realm.setPickerState(state);
    };

    return this;
  }

  /**
   * Attach to the CDP page target, enable `Page`, `DOM`, and `Runtime` domains, configure viewport
   * metrics, and enable silent file chooser & download interception.
   */
  async attach(): Promise<void> {
    if (this.attached) return;

    if (this.sessionId === undefined) {
      try {
        const targets = await this.transport.send<{
          targetInfos?: Array<{ targetId: string; type: string; url: string }>;
        }>("Target.getTargets");

        if (Array.isArray(targets.targetInfos)) {
          const pageTarget = targets.targetInfos.find((t) => t.type === "page");
          let targetId: string;
          if (pageTarget) {
            targetId = pageTarget.targetId;
            if (pageTarget.url && this.currentUrl === "about:blank") {
              this.currentUrl = pageTarget.url;
            }
          } else {
            const created = await this.transport.send<{ targetId: string }>(
              "Target.createTarget",
              { url: this.currentUrl || "about:blank" },
            );
            targetId = created.targetId;
          }

          const attached = await this.transport.send<{ sessionId?: string }>(
            "Target.attachToTarget",
            { targetId, flatten: true },
          );
          if (typeof attached.sessionId === "string") {
            this.sessionId = attached.sessionId;
          }
        }
      } catch {
        // Transport is already scoped to a page session or is a lightweight mock
      }
    }

    await this.sendSession("Page.enable", {});
    await this.sendSession("DOM.enable", {});
    await this.sendSession("Runtime.enable", {});

    await this.sendSession("Emulation.setDeviceMetricsOverride", {
      width: this.currentViewport.width,
      height: this.currentViewport.height,
      deviceScaleFactor: this.currentViewport.scaleFactor ?? 1,
      mobile: false,
    });

    await this.sendSession("Page.setInterceptFileChooserDialog", {
      enabled: true,
    });

    try {
      await this.transport.send("Browser.setDownloadBehavior", {
        behavior: "allowAndName",
        downloadPath: this.downloadPath,
        eventsEnabled: true,
      });
    } catch {
      await this.sendSession("Browser.setDownloadBehavior", {
        behavior: "allowAndName",
        downloadPath: this.downloadPath,
        eventsEnabled: true,
      });
    }

    this.attached = true;
  }

  title(): string {
    return this.currentTitle;
  }

  target(): string {
    return this.currentUrl;
  }

  viewport(): ViewportSize {
    return { ...this.currentViewport };
  }

  pickerState(): ComputerPickerState {
    return {
      ...this.currentPicker,
      files: [...this.currentPicker.files],
      ...(this.currentPicker.accept
        ? { accept: [...this.currentPicker.accept] }
        : {}),
    };
  }

  /**
   * Update viewport dimensions via `Emulation.setDeviceMetricsOverride`.
   */
  async setViewport(viewport: ViewportSize): Promise<void> {
    await this.ensureAttached();
    this.currentViewport = {
      width: viewport.width,
      height: viewport.height,
      scaleFactor: viewport.scaleFactor ?? 1,
    };
    await this.sendSession("Emulation.setDeviceMetricsOverride", {
      width: this.currentViewport.width,
      height: this.currentViewport.height,
      deviceScaleFactor: this.currentViewport.scaleFactor ?? 1,
      mobile: false,
    });
  }

  /**
   * Navigate the active page to `url` and refresh the tracked `title` and `url`.
   */
  async navigate(url: string): Promise<{ url: string; title: string }> {
    await this.ensureAttached();
    await this.sendSession("Page.navigate", { url });
    this.currentUrl = url;
    await this.refreshPageMetadata();
    return {
      url: this.currentUrl,
      title: this.currentTitle,
    };
  }

  /**
   * Capture a clean screenshot (`fromSurface: true`, never drawing a synthetic cursor) with optional
   * `GroundCascade` `CropBox` zoom `clip` rectangle.
   */
  async observe(options?: {
    crop?: CropBox | undefined;
    format?: "png" | "jpeg" | "webp" | undefined;
  }): Promise<RealmObservation> {
    await this.ensureAttached();
    const format = options?.format ?? "png";
    const mimeType =
      format === "jpeg"
        ? "image/jpeg"
        : format === "webp"
          ? "image/webp"
          : "image/png";

    const viewport = this.viewport();
    const resolvedCrop = options?.crop
      ? resolveCropRect(options.crop, viewport)
      : undefined;

    const params: Record<string, unknown> = {
      format,
      fromSurface: true,
    };

    if (resolvedCrop) {
      params.clip = {
        x: resolvedCrop.x,
        y: resolvedCrop.y,
        width: resolvedCrop.width,
        height: resolvedCrop.height,
        scale: viewport.scaleFactor ?? 1,
      };
    }

    const response = await this.sendSession<{ data?: string }>(
      "Page.captureScreenshot",
      params,
    );

    return {
      mimeType,
      data: response.data ?? "",
      viewport,
      ...(resolvedCrop ? { cropRect: resolvedCrop } : {}),
    };
  }

  /**
   * Execute a single micro-action over CDP, intercepting `Control+c`/`Meta+c` and `Control+v`/`Meta+v`
   * into `ctx.clipboard` and reporting `interruptedByModalOrNavigation: true` if a navigation, dialog,
   * or file chooser occurs during the step.
   */
  async step(
    action: ComputerMicroAction,
    ctx: { signal: AbortSignal; clipboard: VirtualClipboard },
  ): Promise<RealmStepResult> {
    await this.ensureAttached();
    if (ctx.signal.aborted) {
      return { summary: "Step aborted" };
    }

    const startUrl = this.currentUrl;
    const startTitle = this.currentTitle;
    this.stepModalOrNavTriggered = false;

    const clipboard = ctx.clipboard ?? this.fallbackClipboard;
    let summary = "";

    switch (action.kind) {
      case "move": {
        const px = toViewportPixels(
          { x: action.x, y: action.y },
          this.currentViewport,
          { unit: action.unit, clamp: true },
        );
        this.lastPointerPx = px;
        await this.sendSession(
          "Input.dispatchMouseEvent",
          {
            type: "mouseMoved",
            x: px.x,
            y: px.y,
            button: "none",
          },
          { signal: ctx.signal },
        );
        summary = `Moved pointer to (${String(px.x)}, ${String(px.y)})`;
        break;
      }

      case "click":
      case "double_click":
      case "right_click": {
        const px = toViewportPixels(
          { x: action.x, y: action.y },
          this.currentViewport,
          { unit: action.unit, clamp: true },
        );
        this.lastPointerPx = px;
        const button =
          action.kind === "right_click" ? "right" : (action.button ?? "left");
        const buttonsMask =
          button === "right" ? 2 : button === "middle" ? 4 : 1;

        await this.sendSession(
          "Input.dispatchMouseEvent",
          {
            type: "mouseMoved",
            x: px.x,
            y: px.y,
            button: "none",
          },
          { signal: ctx.signal },
        );
        await this.sendSession(
          "Input.dispatchMouseEvent",
          {
            type: "mousePressed",
            x: px.x,
            y: px.y,
            button,
            buttons: buttonsMask,
            clickCount: 1,
          },
          { signal: ctx.signal },
        );
        await this.sendSession(
          "Input.dispatchMouseEvent",
          {
            type: "mouseReleased",
            x: px.x,
            y: px.y,
            button,
            buttons: 0,
            clickCount: 1,
          },
          { signal: ctx.signal },
        );

        if (action.kind === "double_click") {
          await this.sendSession(
            "Input.dispatchMouseEvent",
            {
              type: "mousePressed",
              x: px.x,
              y: px.y,
              button,
              buttons: buttonsMask,
              clickCount: 2,
            },
            { signal: ctx.signal },
          );
          await this.sendSession(
            "Input.dispatchMouseEvent",
            {
              type: "mouseReleased",
              x: px.x,
              y: px.y,
              button,
              buttons: 0,
              clickCount: 2,
            },
            { signal: ctx.signal },
          );
        }

        if (this.clickSettleMs > 0) {
          await abortableSleep(this.clickSettleMs, ctx.signal);
        }
        if (this.inFlightFileChooserTask) {
          await this.inFlightFileChooserTask;
        }
        await this.refreshPageMetadata();

        summary = `${action.kind} at (${String(px.x)}, ${String(px.y)})`;
        break;
      }

      case "drag": {
        const fromPx = toViewportPixels(
          { x: action.fromX, y: action.fromY },
          this.currentViewport,
          { unit: action.unit, clamp: true },
        );
        const toPx = toViewportPixels(
          { x: action.toX, y: action.toY },
          this.currentViewport,
          { unit: action.unit, clamp: true },
        );
        this.lastPointerPx = toPx;

        await this.sendSession(
          "Input.dispatchMouseEvent",
          {
            type: "mouseMoved",
            x: fromPx.x,
            y: fromPx.y,
            button: "none",
          },
          { signal: ctx.signal },
        );
        await this.sendSession(
          "Input.dispatchMouseEvent",
          {
            type: "mousePressed",
            x: fromPx.x,
            y: fromPx.y,
            button: "left",
            buttons: 1,
            clickCount: 1,
          },
          { signal: ctx.signal },
        );
        await this.sendSession(
          "Input.dispatchMouseEvent",
          {
            type: "mouseMoved",
            x: toPx.x,
            y: toPx.y,
            button: "left",
            buttons: 1,
          },
          { signal: ctx.signal },
        );
        await this.sendSession(
          "Input.dispatchMouseEvent",
          {
            type: "mouseReleased",
            x: toPx.x,
            y: toPx.y,
            button: "left",
            buttons: 0,
            clickCount: 1,
          },
          { signal: ctx.signal },
        );

        summary = `Dragged (${String(fromPx.x)}, ${String(fromPx.y)}) -> (${String(toPx.x)}, ${String(toPx.y)})`;
        break;
      }

      case "scroll": {
        const px =
          action.x !== undefined && action.y !== undefined
            ? toViewportPixels(
                { x: action.x, y: action.y },
                this.currentViewport,
                { unit: action.unit, clamp: true },
              )
            : this.lastPointerPx;
        this.lastPointerPx = px;

        await this.sendSession(
          "Input.dispatchMouseEvent",
          {
            type: "mouseWheel",
            x: px.x,
            y: px.y,
            deltaX: action.deltaX ?? 0,
            deltaY: action.deltaY,
          },
          { signal: ctx.signal },
        );
        summary = `Scrolled (${String(action.deltaX ?? 0)}, ${String(action.deltaY)})`;
        break;
      }

      case "type": {
        await this.sendSession(
          "Input.insertText",
          { text: action.text },
          { signal: ctx.signal },
        );
        if (action.submit === true) {
          await this.dispatchChord("Enter", ctx.signal);
          await this.refreshPageMetadata();
        }
        summary = `Typed ${String(action.text.length)} chars${action.submit ? " + Enter" : ""}`;
        break;
      }

      case "key": {
        summary = await this.handleKeyAction(action.key, clipboard, ctx.signal);
        if (this.inFlightFileChooserTask) {
          await this.inFlightFileChooserTask;
        }
        break;
      }

      case "wait": {
        await abortableSleep(action.durationMs, ctx.signal);
        summary = `Waited ${String(action.durationMs)}ms`;
        break;
      }
    }

    const urlChanged = this.currentUrl !== startUrl;
    const titleChanged =
      startTitle.length > 0 &&
      this.currentTitle.length > 0 &&
      this.currentTitle !== startTitle;
    const interruptedByModalOrNavigation =
      this.stepModalOrNavTriggered || urlChanged || titleChanged;

    return {
      summary,
      interruptedByModalOrNavigation,
    };
  }

  /**
   * Forward manual user input from `<ComputerViewport />` while `controller === "user"`.
   */
  async userInput(
    input: ComputerUserInput,
    ctx: { clipboard: VirtualClipboard },
  ): Promise<void> {
    const controller = new AbortController();
    switch (input.kind) {
      case "move":
      case "click":
      case "double_click":
      case "right_click":
        await this.step(
          {
            kind: input.kind,
            x: input.x,
            y: input.y,
            unit: "normalized",
          },
          { signal: controller.signal, clipboard: ctx.clipboard },
        );
        break;
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
          { signal: controller.signal, clipboard: ctx.clipboard },
        );
        break;
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
          { signal: controller.signal, clipboard: ctx.clipboard },
        );
        break;
      case "type":
        await this.step(
          { kind: "type", text: input.text },
          { signal: controller.signal, clipboard: ctx.clipboard },
        );
        break;
      case "key":
        await this.step(
          { kind: "key", key: input.key },
          { signal: controller.signal, clipboard: ctx.clipboard },
        );
        break;
    }
  }

  /**
   * Pre-arm the silent file picker (`T5`).
   * Validates `paths` through `FileBrokerPolicy.authorizeFiles(paths, "read")` before arming.
   */
  async stageFiles(paths: string[]): Promise<ComputerPickerState> {
    try {
      const authorized = await this.fileBroker.authorizeFiles(paths, "read");
      this.stagedFiles = [...authorized.allowed];
      const nextState: ComputerPickerState = {
        status: authorized.allowed.length > 0 ? "armed" : "idle",
        files: [...authorized.allowed],
        updatedAt: Date.now(),
      };
      this.setPickerStateInternal(nextState);
      return this.pickerState();
    } catch (err) {
      this.stagedFiles = [];
      this.setPickerStateInternal({
        status: "denied",
        files: [],
        reason: err instanceof Error ? err.message : String(err),
        updatedAt: Date.now(),
      });
      throw err;
    }
  }

  /**
   * Resolve a pending (`status: "pending_input"`) file chooser on demand.
   * Validates `paths` through `FileBrokerPolicy.authorizeFiles(paths, "read")` BEFORE calling
   * `DOM.setFileInputFiles`.
   */
  async resolvePicker(paths: string[]): Promise<ComputerPickerState> {
    let authorizedAllowed: string[];
    try {
      const authorized = await this.fileBroker.authorizeFiles(paths, "read");
      authorizedAllowed = authorized.allowed;
    } catch (err) {
      this.setPickerStateInternal({
        status: "denied",
        mode: this.pendingPickerMode,
        files: [],
        reason: err instanceof Error ? err.message : String(err),
        updatedAt: Date.now(),
      });
      throw err;
    }

    if (this.pendingBackendNodeId === undefined) {
      throw new Error("No pending file chooser dialog to resolve");
    }

    const mode = this.pendingPickerMode ?? "open_single";
    const filesToInject =
      mode === "open_single"
        ? authorizedAllowed.slice(0, 1)
        : [...authorizedAllowed];
    const backendNodeId = this.pendingBackendNodeId;
    this.pendingBackendNodeId = undefined;

    await this.sendSession("DOM.setFileInputFiles", {
      backendNodeId,
      files: filesToInject,
    });

    const nextState: ComputerPickerState = {
      status: "intercepted_silent",
      mode,
      files: filesToInject,
      updatedAt: Date.now(),
    };
    this.setPickerStateInternal(nextState);
    return this.pickerState();
  }

  /**
   * Warm-on-subscribe screencast toggle:
   * - `watched === false`: stops `Page.startScreencast` and polling timer immediately (0 background frames).
   * - `watched === true`: starts `Page.startScreencast` and a throttled 2–6 fps capture loop.
   */
  setWatched(watched: boolean): void {
    if (this.closed) return;
    if (watched === this.watched) return;
    this.watched = watched;

    if (!watched) {
      if (this.screencastTimer !== null) {
        clearInterval(this.screencastTimer);
        this.screencastTimer = null;
      }
      void this.sendSession("Page.stopScreencast", {}).catch(() => {});
      return;
    }

    const cdpFormat = this.screencastFormat === "png" ? "png" : "jpeg";

    void this.ensureAttached()
      .then(() =>
        this.sendSession("Page.startScreencast", {
          format: cdpFormat,
          quality: 80,
          maxWidth: this.currentViewport.width,
          maxHeight: this.currentViewport.height,
          everyNthFrame: 1,
        }),
      )
      .catch(() => {});

    // Trigger an immediate clean frame followed by throttled 2..6 fps polling
    void this.capturePolledFrame();
    const intervalMs = Math.round(1000 / this.screencastFps);
    this.screencastTimer = setInterval(() => {
      void this.capturePolledFrame();
    }, intervalMs);
  }

  /**
   * Stop screencast, remove listeners, and close the underlying CDP transport.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.watched) {
      this.setWatched(false);
    }
    this.closed = true;
    for (const unsub of this.unsubscribeEvents.splice(0)) {
      unsub();
    }
    await this.transport.close();
  }

  private async ensureAttached(): Promise<void> {
    if (!this.attached) {
      await this.attach();
    }
  }

  private sendSession<TResult = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    options?: CdpSendOptions,
  ): Promise<TResult> {
    return this.transport.send<TResult>(method, params, {
      ...options,
      sessionId: options?.sessionId ?? this.sessionId,
    });
  }

  private registerEventListeners(): void {
    this.unsubscribeEvents.push(
      this.transport.on<{
        frame?: { id?: string; parentId?: string; url?: string; name?: string };
      }>("Page.frameNavigated", (params) => {
        const frame = params.frame;
        if (frame && !frame.parentId && typeof frame.url === "string") {
          if (frame.url !== this.currentUrl) {
            this.stepModalOrNavTriggered = true;
          }
          this.currentUrl = frame.url;
          void this.refreshPageMetadata();
        }
      }),
    );

    this.unsubscribeEvents.push(
      this.transport.on<{ frameId?: string; url?: string }>(
        "Page.navigatedWithinDocument",
        (params) => {
          if (typeof params.url === "string") {
            if (params.url !== this.currentUrl) {
              this.stepModalOrNavTriggered = true;
            }
            this.currentUrl = params.url;
          }
        },
      ),
    );

    this.unsubscribeEvents.push(
      this.transport.on("Page.javascriptDialogOpening", () => {
        this.stepModalOrNavTriggered = true;
      }),
    );

    this.unsubscribeEvents.push(
      this.transport.on<{
        frameId?: string;
        mode?: "selectSingle" | "selectMultiple" | string;
        backendNodeId?: number;
      }>("Page.fileChooserOpened", (params) => {
        this.stepModalOrNavTriggered = true;
        const task = this.handleFileChooserOpened(params);
        this.inFlightFileChooserTask = task.finally(() => {
          if (this.inFlightFileChooserTask === task) {
            this.inFlightFileChooserTask = null;
          }
        });
      }),
    );

    this.unsubscribeEvents.push(
      this.transport.on<{
        data?: string;
        sessionId?: number;
      }>("Page.screencastFrame", (params) => {
        if (typeof params.sessionId === "number") {
          void this.sendSession("Page.screencastFrameAck", {
            sessionId: params.sessionId,
          }).catch(() => {});
        }
        if (!this.watched || this.closed) return;
        if (typeof params.data === "string" && params.data.length > 0) {
          this.emitCleanFrame(params.data);
        }
      }),
    );
  }

  private async handleFileChooserOpened(params: {
    frameId?: string;
    mode?: string;
    backendNodeId?: number;
  }): Promise<void> {
    const mode: ComputerPickerMode =
      params.mode === "selectMultiple" ? "open_multiple" : "open_single";
    const backendNodeId = params.backendNodeId;

    if (
      this.currentPicker.status === "armed" &&
      this.stagedFiles.length > 0 &&
      typeof backendNodeId === "number"
    ) {
      const filesToInject =
        mode === "open_single"
          ? this.stagedFiles.slice(0, 1)
          : [...this.stagedFiles];
      this.stagedFiles = [];
      this.pendingBackendNodeId = undefined;
      this.pendingPickerMode = mode;

      await this.sendSession("DOM.setFileInputFiles", {
        backendNodeId,
        files: filesToInject,
      });

      this.setPickerStateInternal({
        status: "intercepted_silent",
        mode,
        files: filesToInject,
        updatedAt: Date.now(),
      });
      return;
    }

    this.pendingBackendNodeId = backendNodeId;
    this.pendingPickerMode = mode;
    this.setPickerStateInternal({
      status: "pending_input",
      mode,
      files: [],
      updatedAt: Date.now(),
    });
  }

  private setPickerStateInternal(next: ComputerPickerState): void {
    this.currentPicker = {
      ...next,
      files: [...next.files],
      ...(next.accept ? { accept: [...next.accept] } : {}),
    };
    this.onPickerChangeCallback?.(this.pickerState());
  }

  private async handleKeyAction(
    key: string,
    clipboard: VirtualClipboard,
    signal: AbortSignal,
  ): Promise<string> {
    const parsed = parseKeyChord(key);
    const lowerPrimary = parsed.primaryKey.toLowerCase();

    // Intercept Control+c / Meta+c -> copy DOM selection into isolated VirtualClipboard
    if (
      parsed.controlOrMeta &&
      !parsed.alt &&
      !parsed.shift &&
      lowerPrimary === "c"
    ) {
      const copyExpression = `(() => {
        const el = document.activeElement;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
          const val = typeof el.value === "string" ? el.value : "";
          const start = typeof el.selectionStart === "number" ? el.selectionStart : 0;
          const end = typeof el.selectionEnd === "number" ? el.selectionEnd : 0;
          if (end > start) {
            return val.slice(start, end);
          }
          return val;
        }
        const sel = typeof window.getSelection === "function" ? window.getSelection() : null;
        return sel ? sel.toString() : "";
      })()`;

      const evalRes = await this.sendSession<{
        result?: { value?: unknown };
      }>(
        "Runtime.evaluate",
        {
          expression: copyExpression,
          returnByValue: true,
        },
        { signal },
      );

      const rawValue = evalRes.result?.value;
      if (typeof rawValue === "string") {
        clipboard.writeText(rawValue);
      } else if (
        rawValue &&
        typeof rawValue === "object" &&
        "text" in rawValue &&
        typeof (rawValue as { text: unknown }).text === "string"
      ) {
        const obj = rawValue as { text: string; html?: string };
        clipboard.write({ text: obj.text, html: obj.html });
      }
      return `Copied selection to VirtualClipboard (${String(clipboard.byteLength)} bytes)`;
    }

    // Intercept Control+v / Meta+v -> paste from isolated VirtualClipboard into DOM
    if (
      parsed.controlOrMeta &&
      !parsed.alt &&
      !parsed.shift &&
      lowerPrimary === "v"
    ) {
      const pasteText = clipboard.readText();
      const serialized = JSON.stringify(pasteText);
      const pasteExpression = `((text) => {
        const el = document.activeElement;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
          const val = typeof el.value === "string" ? el.value : "";
          const start = typeof el.selectionStart === "number" ? el.selectionStart : val.length;
          const end = typeof el.selectionEnd === "number" ? el.selectionEnd : start;
          el.value = val.slice(0, start) + text + val.slice(end);
          const caret = start + text.length;
          if (typeof el.setSelectionRange === "function") {
            try { el.setSelectionRange(caret, caret); } catch {}
          }
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return el.value;
        }
        if (el && el.isContentEditable) {
          document.execCommand("insertText", false, text);
          return el.textContent || "";
        }
        return null;
      })(${serialized})`;

      await this.sendSession(
        "Runtime.evaluate",
        {
          expression: pasteExpression,
          returnByValue: true,
        },
        { signal },
      );
      return `Pasted ${String(pasteText.length)} chars from VirtualClipboard`;
    }

    await this.dispatchChord(key, signal);
    if (lowerPrimary === "enter" || lowerPrimary === "return") {
      await this.refreshPageMetadata();
    }
    return `Pressed key ${key}`;
  }

  private async dispatchChord(
    chord: string,
    signal: AbortSignal,
  ): Promise<void> {
    const parsed = parseKeyChord(chord);
    const def = resolveKeyDefinition(parsed.primaryKey);

    await this.sendSession(
      "Input.dispatchKeyEvent",
      {
        type: def.text && parsed.modifiers === 0 ? "keyDown" : "rawKeyDown",
        modifiers: parsed.modifiers,
        key: def.key,
        code: def.code,
        windowsVirtualKeyCode: def.keyCode,
        nativeVirtualKeyCode: def.keyCode,
        ...(def.text && parsed.modifiers === 0
          ? { text: def.text, unmodifiedText: def.text }
          : {}),
      },
      { signal },
    );

    await this.sendSession(
      "Input.dispatchKeyEvent",
      {
        type: "keyUp",
        modifiers: parsed.modifiers,
        key: def.key,
        code: def.code,
        windowsVirtualKeyCode: def.keyCode,
        nativeVirtualKeyCode: def.keyCode,
      },
      { signal },
    );
  }

  private async refreshPageMetadata(): Promise<void> {
    try {
      const evalRes = await this.sendSession<{
        result?: { value?: { title?: string; url?: string } };
      }>("Runtime.evaluate", {
        expression: "({ title: document.title, url: location.href })",
        returnByValue: true,
      });

      const meta = evalRes.result?.value;
      if (meta && typeof meta === "object") {
        if (typeof meta.title === "string") {
          this.currentTitle = meta.title;
        }
        if (typeof meta.url === "string" && meta.url.length > 0) {
          this.currentUrl = meta.url;
        }
      }
    } catch {
      // Ignore metadata refresh failures on mocked transports
    }
  }

  private async capturePolledFrame(): Promise<void> {
    if (!this.watched || this.closed || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      await this.ensureAttached();
      if (!this.watched || this.closed) return;
      const format =
        this.screencastFormat === "png"
          ? "png"
          : this.screencastFormat === "webp"
            ? "webp"
            : "jpeg";
      const response = await this.sendSession<{ data?: string }>(
        "Page.captureScreenshot",
        {
          format,
          fromSurface: true,
        },
      );
      if (!this.watched || this.closed) return;
      if (typeof response.data === "string" && response.data.length > 0) {
        this.emitCleanFrame(response.data);
      }
    } catch {
      // Ignore transient capture errors while page is closing or navigating
    } finally {
      this.pollInFlight = false;
    }
  }

  private emitCleanFrame(base64Data: string): void {
    if (!this.watched || this.closed) return;
    const mimeType =
      this.screencastFormat === "png"
        ? "image/png"
        : this.screencastFormat === "webp"
          ? "image/webp"
          : "image/jpeg";

    const frameEvent: ComputerFrameEvent = {
      realmId: this.realmId,
      seq: ++this.screencastSeq,
      mimeType,
      data: base64Data,
      viewport: this.viewport(),
      at: Date.now(),
    };
    this.onFrameCallback?.(frameEvent);
  }
}
