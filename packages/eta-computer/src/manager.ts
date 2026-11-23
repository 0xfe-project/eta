import type {
  ComputerController,
  ComputerCursorEvent,
  ComputerCursorState,
  ComputerFrameEvent,
  ComputerIsolationTier,
  ComputerMicroAction,
  ComputerPickerEvent,
  ComputerPickerState,
  ComputerRealmKind,
  ComputerRealmView,
  ComputerUserInput,
  CropBox,
  PixelRect,
  ViewportSize,
} from "@eta/client-contracts";
import type { VirtualClipboardOptions } from "./clipboard";
import type { TrajectoryEvent, TrajectoryRecorderOptions } from "./trajectory";
import { randomUUID } from "node:crypto";
import {
  MAX_MICRO_ACTIONS,
  resolveCropRect,
  toNormalizedPoint,
  toViewportPixels,
} from "@eta/client-contracts";
import { VirtualClipboard } from "./clipboard";
import { TrajectoryRecorder } from "./trajectory";

export interface RealmObservation {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  data: string;
  viewport: ViewportSize;
  cropRect?:
    | { x: number; y: number; width: number; height: number }
    | undefined;
}

export interface RealmStepResult {
  summary?: string | undefined;
  interruptedByModalOrNavigation?: boolean | undefined;
}

/**
 * A driver that can put its own desktop on the user's screen. Implemented by the Windows app realm
 * on a hidden desktop, where "bringing it to the front" means switching the screen to the desktop
 * the app already runs on.
 */
export interface PromotableDriver {
  promote: () => Promise<{ chatFile: string; statusFile: string } | undefined>;
  demote: () => Promise<void>;
}

/**
 * Interface that concrete realm drivers (`BrowserRealm`, `WindowsAppRealm`, or test drivers)
 * implement.
 */
export interface RealmDriver {
  kind: ComputerRealmKind;
  tier: ComputerIsolationTier;
  title: () => string;
  target: () => string;
  viewport: () => ViewportSize;
  observe: (options?: {
    crop?: CropBox | undefined;
    format?: "png" | "jpeg" | "webp" | undefined;
  }) => Promise<RealmObservation>;
  step: (
    action: ComputerMicroAction,
    ctx: { signal: AbortSignal; clipboard: VirtualClipboard },
  ) => Promise<RealmStepResult | void>;
  userInput?: (
    input: ComputerUserInput,
    ctx: { clipboard: VirtualClipboard },
  ) => Promise<void>;
  stageFiles?: (files: string[]) => Promise<ComputerPickerState>;
  resolvePicker?: (files: string[]) => Promise<ComputerPickerState>;
  setWatched?: (watched: boolean) => void;
  close: () => Promise<void>;
}

export interface ManagedRealmMetadata {
  id?: string | undefined;
  machineId?: string | undefined;
  sessionId?: string | undefined;
  conversationId?: string | undefined;
  taskId?: string | undefined;
  agentId?: string | undefined;
  agentName?: string | undefined;
  initialController?: Exclude<ComputerController, "closed"> | undefined;
  clipboardOptions?: VirtualClipboardOptions | undefined;
  recorder?: TrajectoryRecorder | undefined;
}

export interface RealmActOptions {
  /** Optional caller epoch check; rejects immediately if `expectedEpoch !== realm.epoch`. */
  expectedEpoch?: number | undefined;
  /** Optional crop rectangle from the prior zoomed observation for GroundCascade offset math. */
  crop?: CropBox | PixelRect | undefined;
}

export interface RealmActResult {
  completedSteps: number;
  totalSteps: number;
  epoch: number;
  controller: ComputerController;
  cursor: ComputerCursorState;
  summary: string;
  aborted: boolean;
  interruptedByModalOrNavigation: boolean;
}

export type RealmEvent =
  | { type: "state"; realmId: string; view: ComputerRealmView }
  | { type: "frame"; realmId: string; frame: ComputerFrameEvent }
  | { type: "cursor"; realmId: string; cursor: ComputerCursorEvent }
  | { type: "picker"; realmId: string; picker: ComputerPickerEvent };

export type RealmWatchListener = (event: RealmEvent) => void;

function isCropBox(crop: CropBox | PixelRect): crop is CropBox {
  return "unit" in crop && crop.unit !== undefined;
}

function summarizeMicroAction(action: ComputerMicroAction): string {
  switch (action.kind) {
    case "move":
      return `Move to (${String(action.x)}, ${String(action.y)})`;
    case "click":
    case "double_click":
    case "right_click":
      return `${action.kind} at (${String(action.x)}, ${String(action.y)})`;
    case "drag":
      return `Drag (${String(action.fromX)}, ${String(action.fromY)}) -> (${String(action.toX)}, ${String(action.toY)})`;
    case "scroll":
      return `Scroll dy=${String(action.deltaY)}`;
    case "type":
      return `Type ${String(action.text.length)} chars${action.submit ? " + Enter" : ""}`;
    case "key":
      return `Key ${action.key}`;
    case "wait":
      return `Wait ${String(action.durationMs)}ms`;
  }
}

/**
 * Wraps a `RealmDriver` with a single-writer controller lock (`agent | user | paused | closed`),
 * monotonic `epoch`, instant mid-batch `AbortController` cancellation, isolated `VirtualClipboard`,
 * normalized `0..1000` cursor broadcasts, and warm-on-subscribe watcher transitions.
 */
export class ManagedRealm {
  readonly id: string;
  readonly driver: RealmDriver;
  readonly clipboard: VirtualClipboard;
  readonly recorder: TrajectoryRecorder;
  readonly machineId: string;
  readonly sessionId: string;
  readonly conversationId: string | undefined;
  readonly taskId: string | undefined;
  readonly agentId: string | undefined;
  readonly agentName: string | undefined;
  readonly createdAt: number;

  private currentController: ComputerController;
  private currentEpoch = 1;
  private activeBatchAbort: AbortController | null = null;
  private batchInFlight = false;
  private frameSeq = 0;
  private currentCursor: ComputerCursorState;
  private currentPicker: ComputerPickerState;
  private currentSummary: string;
  private currentPromoted = false;
  private lastUpdatedAt: number;
  private readonly watchers = new Set<RealmWatchListener>();
  private readonly cursorListeners = new Set<
    (event: ComputerCursorEvent) => void
  >();
  private readonly frameListeners = new Set<
    (event: ComputerFrameEvent) => void
  >();
  private readonly pickerListeners = new Set<
    (event: ComputerPickerEvent) => void
  >();
  private readonly stateListeners = new Set<
    (view: ComputerRealmView) => void
  >();

  constructor(driver: RealmDriver, metadata: ManagedRealmMetadata = {}) {
    const now = Date.now();
    this.id = metadata.id ?? `realm_${randomUUID()}`;
    this.driver = driver;
    this.clipboard = new VirtualClipboard(metadata.clipboardOptions);
    this.recorder = metadata.recorder ?? new TrajectoryRecorder();
    this.machineId = metadata.machineId ?? "local";
    this.sessionId = metadata.sessionId ?? "default";
    this.conversationId = metadata.conversationId;
    this.taskId = metadata.taskId;
    this.agentId = metadata.agentId;
    this.agentName = metadata.agentName;
    this.createdAt = now;
    this.lastUpdatedAt = now;
    this.currentController = metadata.initialController ?? "agent";
    this.currentCursor = {
      x: 500,
      y: 500,
      kind: "move",
      at: now,
    };
    this.currentPicker = {
      status: "idle",
      files: [],
      updatedAt: now,
    };
    this.currentSummary = `Opened ${driver.kind} realm (${driver.target()})`;

    this.recorder.record({
      kind: "open",
      realmId: this.id,
      epoch: this.currentEpoch,
      controller: this.currentController,
      summary: this.currentSummary,
      viewport: driver.viewport(),
    });
  }

  get controller(): ComputerController {
    return this.currentController;
  }

  get epoch(): number {
    return this.currentEpoch;
  }

  get cursor(): ComputerCursorState {
    return { ...this.currentCursor };
  }

  get picker(): ComputerPickerState {
    return {
      ...this.currentPicker,
      files: [...this.currentPicker.files],
      ...(this.currentPicker.accept
        ? { accept: [...this.currentPicker.accept] }
        : {}),
    };
  }

  get summary(): string {
    return this.currentSummary;
  }

  get updatedAt(): number {
    return this.lastUpdatedAt;
  }

  get watcherCount(): number {
    return this.watchers.size;
  }

  get isWatched(): boolean {
    return this.watchers.size > 0;
  }

  /** Build an immutable `ComputerRealmView` snapshot. */
  view(): ComputerRealmView {
    return {
      id: this.id,
      kind: this.driver.kind,
      tier: this.driver.tier,
      machineId: this.machineId,
      sessionId: this.sessionId,
      conversationId: this.conversationId,
      taskId: this.taskId,
      agentId: this.agentId,
      agentName: this.agentName,
      title: this.driver.title(),
      target: this.driver.target(),
      viewport: this.driver.viewport(),
      controller: this.currentController,
      epoch: this.currentEpoch,
      cursor: this.cursor,
      picker: this.picker,
      summary: this.currentSummary,
      promoted: this.currentPromoted,
      createdAt: this.createdAt,
      updatedAt: this.lastUpdatedAt,
    };
  }

  /** Whether this realm's desktop is the one on the user's screen. */
  get isPromoted(): boolean {
    return this.currentPromoted;
  }

  /**
   * The driver's screen-switching half, when it has one. Almost no driver does: only a Windows app
   * realm on a hidden desktop can hand its desktop to the user.
   */
  driverForPromote(): PromotableDriver | undefined {
    const candidate = this.driver as Partial<PromotableDriver>;
    if (typeof candidate.promote !== "function") {
      return undefined;
    }
    if (typeof candidate.demote !== "function") {
      return undefined;
    }
    return candidate as PromotableDriver;
  }

  /** Record that the realm's desktop was switched onto (or back off) the user's screen. */
  setPromoted(promoted: boolean): ComputerRealmView {
    if (this.currentPromoted === promoted) {
      return this.view();
    }
    this.currentPromoted = promoted;
    this.touch(
      promoted ? "Brought to the user's screen" : "Returned to the background",
    );
    return this.view();
  }

  /** Capture a clean screenshot observation (optional crop for GroundCascade zoom checks). */
  async observe(options?: {
    crop?: CropBox | undefined;
    format?: "png" | "jpeg" | "webp" | undefined;
  }): Promise<RealmObservation> {
    this.assertNotClosed();
    const viewport = this.driver.viewport();
    const resolvedCrop = options?.crop
      ? resolveCropRect(options.crop, viewport)
      : undefined;
    const observation = await this.driver.observe(options);
    const result: RealmObservation = {
      ...observation,
      cropRect: observation.cropRect ?? resolvedCrop,
    };

    this.touch(`Observed ${this.driver.title() || this.driver.target()}`);
    this.recorder.record({
      kind: "observe",
      realmId: this.id,
      epoch: this.currentEpoch,
      controller: this.currentController,
      summary: this.currentSummary,
      crop: options?.crop,
      viewport: observation.viewport,
    });

    if (this.isWatched && !options?.crop) {
      this.emitFrame({
        mimeType: observation.mimeType,
        data: observation.data,
        viewport: observation.viewport,
      });
    }

    return result;
  }

  /**
   * Execute a batch of up to `MAX_MICRO_ACTIONS` (8) micro-actions while `controller === "agent"`.
   * Any concurrent `takeover()`, `pause()`, `stop()`, or `close()` increments `epoch` and
   * immediately aborts the in-flight `AbortController` so remaining steps never execute.
   */
  async act(
    actions: readonly ComputerMicroAction[],
    options: RealmActOptions = {},
  ): Promise<RealmActResult> {
    this.assertNotClosed();
    if (this.currentController !== "agent") {
      throw new Error(
        `Cannot execute agent actions while realm "${this.id}" controller is "${this.currentController}"`,
      );
    }
    if (
      options.expectedEpoch !== undefined &&
      options.expectedEpoch !== this.currentEpoch
    ) {
      throw new Error(
        `Stale epoch for realm "${this.id}": expected ${String(options.expectedEpoch)}, current is ${String(this.currentEpoch)}`,
      );
    }
    if (actions.length > MAX_MICRO_ACTIONS) {
      throw new RangeError(
        `Micro-action batch size ${String(actions.length)} exceeds MAX_MICRO_ACTIONS (${String(MAX_MICRO_ACTIONS)})`,
      );
    }
    if (this.batchInFlight) {
      throw new Error(
        `Realm "${this.id}" already has an action batch in flight`,
      );
    }

    const startEpoch = this.currentEpoch;
    const abortController = new AbortController();
    this.activeBatchAbort = abortController;
    this.batchInFlight = true;

    let completedSteps = 0;
    let aborted = false;
    let interruptedByModalOrNavigation = false;
    let lastStepSummary = "No actions executed";

    try {
      for (const action of actions) {
        if (
          abortController.signal.aborted ||
          this.currentEpoch !== startEpoch ||
          this.currentController !== "agent"
        ) {
          aborted = true;
          break;
        }

        const viewport = this.driver.viewport();
        const cropRect =
          options.crop !== undefined
            ? isCropBox(options.crop)
              ? resolveCropRect(options.crop, viewport)
              : options.crop
            : undefined;

        this.updateCursorForMicroAction(action, viewport, cropRect);

        const stepResult = await this.driver.step(action, {
          signal: abortController.signal,
          clipboard: this.clipboard,
        });

        if (
          abortController.signal.aborted ||
          this.currentEpoch !== startEpoch ||
          this.currentController !== "agent"
        ) {
          aborted = true;
          break;
        }

        completedSteps += 1;
        lastStepSummary = stepResult?.summary ?? summarizeMicroAction(action);
        this.touch(lastStepSummary);

        if (stepResult?.interruptedByModalOrNavigation === true) {
          interruptedByModalOrNavigation = true;
          break;
        }
      }
    } finally {
      if (this.activeBatchAbort === abortController) {
        this.activeBatchAbort = null;
      }
      this.batchInFlight = false;
    }

    this.recorder.record({
      kind: "act",
      realmId: this.id,
      epoch: this.currentEpoch,
      controller: this.currentController,
      summary: lastStepSummary,
      actions,
      completedSteps,
      interrupted: aborted || interruptedByModalOrNavigation,
    });

    return {
      completedSteps,
      totalSteps: actions.length,
      epoch: this.currentEpoch,
      controller: this.currentController,
      cursor: this.cursor,
      summary: this.currentSummary,
      aborted,
      interruptedByModalOrNavigation,
    };
  }

  /** Forward manual user input from `<ComputerViewport />` only when `controller === "user"`. */
  async userInput(input: ComputerUserInput): Promise<void> {
    this.assertNotClosed();
    if (this.currentController !== "user") {
      throw new Error(
        `Cannot send manual user input while realm "${this.id}" controller is "${this.currentController}"`,
      );
    }

    this.updateCursorForUserInput(input);
    if (this.driver.userInput) {
      await this.driver.userInput(input, { clipboard: this.clipboard });
    } else {
      const microAction = this.userInputToMicroAction(input);
      const controller = new AbortController();
      await this.driver.step(microAction, {
        signal: controller.signal,
        clipboard: this.clipboard,
      });
    }
    this.touch(`User ${input.kind}`);
  }

  /** Pre-arm the silent file picker broker with workspace files. */
  async stageFiles(files: string[]): Promise<ComputerPickerState> {
    this.assertNotClosed();
    const nextPicker: ComputerPickerState = this.driver.stageFiles
      ? await this.driver.stageFiles(files)
      : {
          status: files.length > 0 ? "armed" : "idle",
          files: [...files],
          updatedAt: Date.now(),
        };
    this.setPickerState(
      nextPicker,
      `Armed file picker (${String(files.length)} file(s))`,
    );
    return this.picker;
  }

  /** Resolve a pending file picker with user-selected or approved files. */
  async resolvePicker(files: string[]): Promise<ComputerPickerState> {
    this.assertNotClosed();
    const nextPicker: ComputerPickerState = this.driver.resolvePicker
      ? await this.driver.resolvePicker(files)
      : {
          status: "intercepted_silent",
          files: [...files],
          updatedAt: Date.now(),
        };
    this.setPickerState(
      nextPicker,
      `Resolved file picker (${String(files.length)} file(s))`,
    );
    return this.picker;
  }

  /** Update picker state and broadcast a `picker` event. */
  setPickerState(state: ComputerPickerState, summary?: string): void {
    this.currentPicker = {
      ...state,
      files: [...state.files],
      ...(state.accept ? { accept: [...state.accept] } : {}),
    };
    this.touch(summary ?? `Picker ${state.status}`);
    this.recorder.record({
      kind: "picker",
      realmId: this.id,
      epoch: this.currentEpoch,
      controller: this.currentController,
      summary: this.currentSummary,
      picker: this.picker,
    });
    const event: ComputerPickerEvent = {
      ...this.picker,
      realmId: this.id,
    };
    for (const listener of this.pickerListeners) {
      listener(event);
    }
    for (const watcher of this.watchers) {
      watcher({ type: "picker", realmId: this.id, picker: event });
    }
  }

  /** Record a trajectory verification checkpoint (`verify`). */
  verify(
    summary: string,
    verified = true,
    metadata?: Record<string, unknown>,
  ): TrajectoryEvent {
    this.touch(summary);
    return this.recorder.record({
      kind: "verify",
      realmId: this.id,
      epoch: this.currentEpoch,
      controller: this.currentController,
      summary,
      verified,
      metadata,
    });
  }

  /** Transfer control to the human user (`controller = "user"`), incrementing `epoch` and aborting any active agent batch. */
  takeover(reason = "User took over control"): ComputerRealmView {
    this.assertNotClosed();
    this.transitionController("user", reason);
    this.recorder.record({
      kind: "takeover",
      realmId: this.id,
      epoch: this.currentEpoch,
      controller: this.currentController,
      summary: reason,
    });
    return this.view();
  }

  /** Release control back to the agent (`controller = "agent"`), incrementing `epoch`. */
  release(reason = "Returned control to agent"): ComputerRealmView {
    this.assertNotClosed();
    this.transitionController("agent", reason);
    this.recorder.record({
      kind: "release",
      realmId: this.id,
      epoch: this.currentEpoch,
      controller: this.currentController,
      summary: reason,
    });
    return this.view();
  }

  /** Alias for `release()` to support `resume` wire action. */
  resume(reason = "Resumed agent control"): ComputerRealmView {
    return this.release(reason);
  }

  /** Pause the realm (`controller = "paused"`), incrementing `epoch` and aborting any active agent batch. */
  pause(reason = "Paused realm"): ComputerRealmView {
    this.assertNotClosed();
    this.transitionController("paused", reason);
    this.recorder.record({
      kind: "pause",
      realmId: this.id,
      epoch: this.currentEpoch,
      controller: this.currentController,
      summary: reason,
    });
    return this.view();
  }

  /** Emergency stop: pause the realm (`controller = "paused"`), increment `epoch`, and abort any active batch immediately. */
  stop(reason = "Stopped realm"): ComputerRealmView {
    this.assertNotClosed();
    this.transitionController("paused", reason);
    this.recorder.record({
      kind: "stop",
      realmId: this.id,
      epoch: this.currentEpoch,
      controller: this.currentController,
      summary: reason,
    });
    return this.view();
  }

  /** Close the realm, abort any in-flight work, notify `setWatched(false)` if watched, and dispose the driver. */
  async close(reason = "Closed realm"): Promise<ComputerRealmView> {
    if (this.currentController === "closed") {
      return this.view();
    }
    const wasWatched = this.watchers.size > 0;
    this.watchers.clear();
    if (wasWatched) {
      this.driver.setWatched?.(false);
    }
    this.transitionController("closed", reason);
    await this.driver.close();
    return this.view();
  }

  /**
   * Subscribe to live realm events (`state`, `frame`, `cursor`, `picker`).
   * Triggers `driver.setWatched?.(true)` on `0 -> 1` transition and `driver.setWatched?.(false)`
   * on `1 -> 0` transition (warm-on-subscribe).
   */
  watch(listener: RealmWatchListener): () => void {
    if (this.currentController === "closed") {
      return () => {};
    }
    const prevCount = this.watchers.size;
    this.watchers.add(listener);
    if (prevCount === 0 && this.watchers.size === 1) {
      this.driver.setWatched?.(true);
    }

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.watchers.delete(listener) && this.watchers.size === 0) {
        this.driver.setWatched?.(false);
      }
    };
  }

  /** Subscribe specifically to normalized `ComputerCursorEvent` broadcasts. */
  onCursor(listener: (event: ComputerCursorEvent) => void): () => void {
    this.cursorListeners.add(listener);
    return () => {
      this.cursorListeners.delete(listener);
    };
  }

  /** Subscribe specifically to live `ComputerFrameEvent` broadcasts. */
  onFrame(listener: (event: ComputerFrameEvent) => void): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  /** Subscribe specifically to `ComputerPickerEvent` broadcasts. */
  onPicker(listener: (event: ComputerPickerEvent) => void): () => void {
    this.pickerListeners.add(listener);
    return () => {
      this.pickerListeners.delete(listener);
    };
  }

  /** Subscribe specifically to `ComputerRealmView` state transitions. */
  onState(listener: (view: ComputerRealmView) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /** Emit a clean frame to active watchers. */
  emitFrame(frame: {
    mimeType: "image/jpeg" | "image/png" | "image/webp";
    data: string;
    viewport: ViewportSize;
    at?: number | undefined;
  }): ComputerFrameEvent {
    const event: ComputerFrameEvent = {
      realmId: this.id,
      seq: ++this.frameSeq,
      mimeType: frame.mimeType,
      data: frame.data,
      viewport: frame.viewport,
      at: frame.at ?? Date.now(),
    };
    for (const listener of this.frameListeners) {
      listener(event);
    }
    for (const watcher of this.watchers) {
      watcher({ type: "frame", realmId: this.id, frame: event });
    }
    return event;
  }

  private assertNotClosed(): void {
    if (this.currentController === "closed") {
      throw new Error(`Realm "${this.id}" is closed`);
    }
  }

  private transitionController(
    next: ComputerController,
    summary: string,
  ): void {
    this.currentEpoch += 1;
    this.currentController = next;
    if (this.activeBatchAbort) {
      this.activeBatchAbort.abort(
        new Error(
          `Realm "${this.id}" transitioned to "${next}" (epoch ${String(this.currentEpoch)})`,
        ),
      );
      this.activeBatchAbort = null;
    }
    this.touch(summary);
  }

  private touch(summary: string): void {
    this.currentSummary = summary;
    this.lastUpdatedAt = Date.now();
    const currentView = this.view();
    for (const listener of this.stateListeners) {
      listener(currentView);
    }
    for (const watcher of this.watchers) {
      watcher({ type: "state", realmId: this.id, view: currentView });
    }
  }

  private updateCursorForMicroAction(
    action: ComputerMicroAction,
    viewport: ViewportSize,
    cropRect?: PixelRect,
  ): void {
    const now = Date.now();
    let x = this.currentCursor.x;
    let y = this.currentCursor.y;
    let label: string | undefined;

    switch (action.kind) {
      case "move":
      case "click":
      case "double_click":
      case "right_click": {
        const px = toViewportPixels({ x: action.x, y: action.y }, viewport, {
          unit: action.unit,
          crop: cropRect,
        });
        const norm = toNormalizedPoint(px, viewport);
        x = norm.x;
        y = norm.y;
        break;
      }
      case "drag": {
        const px = toViewportPixels(
          { x: action.toX, y: action.toY },
          viewport,
          { unit: action.unit, crop: cropRect },
        );
        const norm = toNormalizedPoint(px, viewport);
        x = norm.x;
        y = norm.y;
        break;
      }
      case "scroll": {
        if (action.x !== undefined && action.y !== undefined) {
          const px = toViewportPixels({ x: action.x, y: action.y }, viewport, {
            unit: action.unit,
            crop: cropRect,
          });
          const norm = toNormalizedPoint(px, viewport);
          x = norm.x;
          y = norm.y;
        }
        label = `scroll ${String(action.deltaY)}`;
        break;
      }
      case "type":
        label = action.text;
        break;
      case "key":
        label = action.key;
        break;
      case "wait":
        label = `${String(action.durationMs)}ms`;
        break;
    }

    this.setCursorState({
      x,
      y,
      kind: action.kind,
      label,
      at: now,
    });
  }

  private updateCursorForUserInput(input: ComputerUserInput): void {
    const now = Date.now();
    let x = this.currentCursor.x;
    let y = this.currentCursor.y;
    let label: string | undefined;

    switch (input.kind) {
      case "move":
      case "click":
      case "double_click":
      case "right_click":
      case "scroll":
        x = input.x;
        y = input.y;
        break;
      case "drag":
        x = input.toX;
        y = input.toY;
        break;
      case "type":
        label = input.text;
        break;
      case "key":
        label = input.key;
        break;
    }

    this.setCursorState({
      x,
      y,
      kind: input.kind,
      label,
      at: now,
    });
  }

  private setCursorState(next: ComputerCursorState): void {
    this.currentCursor = next;
    const event: ComputerCursorEvent = {
      ...next,
      realmId: this.id,
      epoch: this.currentEpoch,
    };
    for (const listener of this.cursorListeners) {
      listener(event);
    }
    for (const watcher of this.watchers) {
      watcher({ type: "cursor", realmId: this.id, cursor: event });
    }
  }

  private userInputToMicroAction(
    input: ComputerUserInput,
  ): ComputerMicroAction {
    switch (input.kind) {
      case "move":
        return { kind: "move", x: input.x, y: input.y, unit: "normalized" };
      case "click":
      case "double_click":
      case "right_click":
        return { kind: input.kind, x: input.x, y: input.y, unit: "normalized" };
      case "drag":
        return {
          kind: "drag",
          fromX: input.fromX,
          fromY: input.fromY,
          toX: input.toX,
          toY: input.toY,
          unit: "normalized",
        };
      case "scroll":
        return {
          kind: "scroll",
          x: input.x,
          y: input.y,
          deltaX: input.deltaX,
          deltaY: input.deltaY,
          unit: "normalized",
        };
      case "type":
        return { kind: "type", text: input.text };
      case "key":
        return { kind: "key", key: input.key };
    }
  }
}

export interface RealmManagerOptions {
  machineId?: string | undefined;
  clipboardOptions?: VirtualClipboardOptions | undefined;
  trajectoryOptions?: TrajectoryRecorderOptions | undefined;
  recorder?: TrajectoryRecorder | undefined;
}

/**
 * Registry and lifecycle manager for all isolated Computer Use realms in a session or process.
 */
export class RealmManager {
  readonly machineId: string;
  readonly recorder: TrajectoryRecorder;
  private readonly defaultClipboardOptions: VirtualClipboardOptions | undefined;
  private readonly realms = new Map<string, ManagedRealm>();

  constructor(options: RealmManagerOptions = {}) {
    this.machineId = options.machineId ?? "local";
    this.defaultClipboardOptions = options.clipboardOptions;
    this.recorder =
      options.recorder ?? new TrajectoryRecorder(options.trajectoryOptions);
  }

  /** Register a `RealmDriver` and return its `ManagedRealm` wrapper. */
  register(
    driver: RealmDriver,
    metadata: ManagedRealmMetadata = {},
  ): ManagedRealm {
    const id = metadata.id ?? `realm_${randomUUID()}`;
    if (this.realms.has(id)) {
      throw new Error(`Realm with id "${id}" already exists`);
    }
    const realm = new ManagedRealm(driver, {
      ...metadata,
      id,
      machineId: metadata.machineId ?? this.machineId,
      clipboardOptions:
        metadata.clipboardOptions ?? this.defaultClipboardOptions,
      recorder: metadata.recorder ?? this.recorder,
    });
    this.realms.set(realm.id, realm);
    // A driver that draws live frames needs the realm to draw them into; binding here means no
    // caller (the service, a script, a test) has to remember to.
    const bindable = driver as { bindRealm?: (realm: ManagedRealm) => unknown };
    bindable.bindRealm?.(realm);
    return realm;
  }

  /** Look up a realm by ID (returns `undefined` if not found). */
  get(realmId: string): ManagedRealm | undefined {
    return this.realms.get(realmId);
  }

  /** Look up a realm by ID or throw if it does not exist. */
  require(realmId: string): ManagedRealm {
    const realm = this.realms.get(realmId);
    if (!realm) {
      throw new Error(`Unknown computer realm: "${realmId}"`);
    }
    return realm;
  }

  /** Return all managed realms. */
  list(): ManagedRealm[] {
    return [...this.realms.values()];
  }

  /** Return `ComputerRealmView` snapshots for all managed realms. */
  views(): ComputerRealmView[] {
    return this.list().map((realm) => realm.view());
  }

  /** Subscribe a watcher to a specific realm by ID. */
  watch(realmId: string, listener: RealmWatchListener): () => void {
    return this.require(realmId).watch(listener);
  }

  /** Close a specific realm by ID and optionally remove it from the active registry. */
  async close(
    realmId: string,
    options?: { remove?: boolean | undefined },
  ): Promise<ComputerRealmView> {
    const realm = this.require(realmId);
    const view = await realm.close();
    if (options?.remove === true) {
      this.realms.delete(realmId);
    }
    return view;
  }

  /** Close all registered realms. */
  async closeAll(): Promise<void> {
    const all = this.list();
    await Promise.all(all.map((realm) => realm.close()));
  }
}
