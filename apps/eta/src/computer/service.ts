import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ComputerAction,
  ComputerController,
  ComputerIsolationTier,
  ComputerMachineCapabilities,
  ComputerMicroAction,
  ComputerPickerState,
  ComputerRealmKind,
  ComputerRealmView,
  ComputerUserInput,
  CoordinateUnit,
  CropBox,
  Point2D,
  ViewportSize,
} from "@eta/client-contracts";
import type {
  BrowserRealmLaunchOptions,
  FileBrokerApprovalCallback,
  FileBrokerApprovalRequest,
  FileBrokerMode,
  FileBrokerPolicyOptions,
  ManagedRealm,
  ManagedRealmMetadata,
  ProbeWindowsCapabilitiesOptions,
  RealmActOptions,
  RealmActResult,
  RealmDriver,
  RealmManagerOptions,
  RealmObservation,
  RealmStepResult,
  VirtualClipboard,
  VirtualClipboardPayload,
  VirtualClipboardSnapshot,
  WindowsAppRealmDriverOptions,
} from "@eta/computer";
import type { KernelModels } from "@eta/core";
import type { AskRegistry, AskResponse } from "@eta/harness";
import type { SessionMeta } from "@eta/server";
import type { ComputerRealmMirrors } from "./mirror";
/**
 * ComputerService (`apps/eta/src/computer/service.ts`):
 *
 * Host-level coordinator for Computer Use realms (`browser` and `app`), remote daemon realm
 * mirrors, model vision capability gating, fast/slow grounder routing (`groundingModel`) with
 * full usage accounting, and `FileBrokerPolicy` approval routing through the session's `ask` /
 * `Inbox` channel.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  NORMALIZED_MAX,
  PERCENT_MAX,
  resolveCropRect,
  toNormalizedPoint,
  toViewportPixels,
} from "@eta/client-contracts";
import {
  checkProcessTargetAllowed,
  createSolidPngBuffer,
  FileBrokerPolicy,
  HiddenDesktopError,
  probeWindowsCapabilities,
  RealmManager,
} from "@eta/computer";
import { parseModelId } from "@eta/server";

export type VisionGateCheckResult =
  | {
      ok: true;
      modelId: string;
    }
  | {
      ok: false;
      code: "computer_model_lacks_vision";
      modelId: string;
      message: string;
    };

/**
 * Checks whether `model` supports `"image"` input for Computer Use.
 *
 * Returns a structured failure with `computer_model_lacks_vision` when the model is text-only
 * (`!model.input?.includes("image")`).
 */
export function checkModelSupportsVision(
  model:
    | { id: string; input?: readonly ("text" | "image")[] | undefined }
    | undefined,
): VisionGateCheckResult {
  if (model === undefined) {
    return {
      ok: false,
      code: "computer_model_lacks_vision",
      modelId: "unknown",
      message:
        "computer_model_lacks_vision: model unknown does not support image input; choose a multimodal model such as gpt-6.2-sol, gemini-4-hydrogen, or claude-opus-5.5",
    };
  }
  const hasVision = Array.isArray(model.input) && model.input.includes("image");
  if (!hasVision) {
    return {
      ok: false,
      code: "computer_model_lacks_vision",
      modelId: model.id,
      message: `computer_model_lacks_vision: model ${model.id} does not support image input; choose a multimodal model such as gpt-6.2-sol, gemini-4-hydrogen, or claude-opus-5.5`,
    };
  }
  return {
    ok: true,
    modelId: model.id,
  };
}

export interface RealmBindingMetadata {
  sessionId: string;
  agentId?: string | undefined;
  agentName?: string | undefined;
  conversationId?: string | undefined;
  taskId?: string | undefined;
  machineId?: string | undefined;
  cwd?: string | undefined;
}

export interface OpenRealmRequest extends RealmBindingMetadata {
  id?: string | undefined;
  kind: ComputerRealmKind;
  target: string;
  /** Optional command-line arguments passed when launching an `app` realm (e.g. `["--python", "script.py"]`). */
  args?: readonly string[] | undefined;
  /**
   * Optional inline script written by the host into its computer staging directory and passed to
   * the launched app via `[flag ?? "--python", scriptPath]`. Avoids opening Notepad or shell tools
   * just to create a script file for scriptable apps like Blender.
   */
  script?:
    | {
        content: string;
        extension?: string | undefined;
        flag?: string | undefined;
      }
    | undefined;
  title?: string | undefined;
  viewport?: ViewportSize | undefined;
  reuse?: boolean | undefined;
  initialController?: Exclude<ComputerController, "closed"> | undefined;
  driver?: RealmDriver | undefined;
  /**
   * Adopt an app that is already running on this desktop instead of launching one. Used to rebuild
   * a realm whose app outlived the host, so the user gets their window back instead of losing it.
   */
  attachTo?: string | undefined;
}

interface DriverFactoryContext extends OpenRealmRequest {
  machineId: string;
  fileBroker: FileBrokerPolicy;
  capabilities: ComputerMachineCapabilities;
}

/** One desktop that holds a live app, as remembered across host restarts. */
interface PersistedScreen {
  realmId: string;
  desktopName: string;
  target: string;
  title?: string | undefined;
  viewport: { width: number; height: number; scaleFactor: number };
  sessionId: string;
  conversationId?: string | undefined;
  agentId?: string | undefined;
  agentName?: string | undefined;
  taskId?: string | undefined;
  machineId: string;
  openedAt: number;
}

export type ComputerDriverFactory = (
  ctx: DriverFactoryContext,
) => Promise<RealmDriver> | RealmDriver;

export interface GrounderLocateRequest {
  realmId?: string | undefined;
  prompt: string;
  image: {
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    data: string;
  };
  viewport: ViewportSize;
  crop?: CropBox | undefined;
  meta: SessionMeta;
  signal?: AbortSignal | undefined;
}

export interface GrounderLocateResult {
  modelId: string;
  rawText: string;
  /** Local coordinate in the provided image/crop (0..1000 normalized). */
  localNormalized?: Point2D | undefined;
  /** Full-viewport normalized coordinate (0..1000) after applying crop offset. */
  viewportNormalized?: Point2D | undefined;
  /** Physical viewport pixel coordinate. */
  viewportPixel?: Point2D | undefined;
  message: AssistantMessage;
}

export type ComputerAskUserCallback = (request: {
  questionId: string;
  question: string;
  options: string[];
  meta?: SessionMeta | undefined;
  signal?: AbortSignal | undefined;
}) => Promise<AskResponse | "allow" | "deny" | boolean>;

export interface ComputerServiceOptions {
  machineId?: string | undefined;
  manager?: RealmManager | undefined;
  managerOptions?: RealmManagerOptions | undefined;
  mirrors?: ComputerRealmMirrors | undefined;
  capabilities?:
    | ComputerMachineCapabilities
    | (() => ComputerMachineCapabilities)
    | undefined;
  probeOptions?: ProbeWindowsCapabilitiesOptions | undefined;
  groundingModel?: string | null | undefined;
  models?: KernelModels | (() => KernelModels | undefined) | undefined;
  onGenerated?:
    | ((meta: SessionMeta, message: AssistantMessage) => void)
    | undefined;
  driverFactory?: ComputerDriverFactory | undefined;
  browserOptions?: Partial<BrowserRealmLaunchOptions> | undefined;
  windowsAppOptions?: Partial<WindowsAppRealmDriverOptions> | undefined;
  fileBrokerOptions?: FileBrokerPolicyOptions | undefined;
  askUser?: ComputerAskUserCallback | undefined;
  /**
   * Send a chat line typed in the in-realm overlay to the conversation that owns the realm, so the
   * user can talk to the agent without leaving the switched desktop.
   */
  sendChat?:
    | ((conversationId: string, text: string) => void | Promise<void>)
    | undefined;
  /**
   * Read the latest assistant reply text for the conversation owning a promoted realm, displayed
   * inside the native desktop overlay so the user sees replies without leaving the desktop.
   */
  latestReply?: ((conversationId: string) => string | undefined) | undefined;
  changed?: (() => void) | undefined;
  /**
   * Where to remember which desktops hold a live app, so a host restart can adopt them again
   * instead of leaving the user with an app they can no longer reach.
   */
  dataDir?: string | undefined;
}

/**
 * Normalize a realm target for reuse matching: on `app` realms, `"blender.exe"` and
 * `"C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe"` refer to the same app, so
 * calling `computer_open` again reuses the existing realm instead of spawning duplicate instances.
 */
function normalizeReuseTarget(kind: ComputerRealmKind, target: string): string {
  const trimmed = target.trim();
  if (kind !== "app") return trimmed;
  const base = path.win32.basename(trimmed).toLowerCase();
  return base.endsWith(".exe") ? base : `${base}.exe`;
}

/**
 * Hand the realm to a driver that draws into one (the browser's screencast, the hidden desktop's
 * live frames). A driver without that ability never sees it.
 */
function bindRealmIfAny(driver: RealmDriver, realm: ManagedRealm): void {
  const bindable = driver as { bindRealm?: (realm: ManagedRealm) => unknown };
  bindable.bindRealm?.(realm);
}

function isApprovedAnswer(
  answer: AskResponse | "allow" | "deny" | boolean,
): boolean {
  if (typeof answer === "boolean") return answer;
  if (typeof answer === "string") {
    return answer.trim().toLowerCase() === "allow";
  }
  if (answer.kind === "selection") {
    return answer.selections.some((s) => s.trim().toLowerCase() === "allow");
  }
  if (answer.kind === "freeform") {
    return answer.text.trim().toLowerCase() === "allow";
  }
  return false;
}

/**
 * Parse a 2D point from a grounder model's text reply.
 * Supports JSON `{"x": 450, "y": 320, "unit": "normalized"}`, `(450, 320)`, or `[450, 320]`.
 */
export function parseGroundedCoordinate(
  text: string,
): { x: number; y: number; unit?: CoordinateUnit | undefined } | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const jsonMatch = /\{[\s\S]*?\}/.exec(trimmed);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        x?: unknown;
        y?: unknown;
        point?: unknown;
        unit?: unknown;
      };
      if (
        typeof parsed.x === "number" &&
        Number.isFinite(parsed.x) &&
        typeof parsed.y === "number" &&
        Number.isFinite(parsed.y)
      ) {
        const unit =
          parsed.unit === "normalized" ||
          parsed.unit === "percent" ||
          parsed.unit === "pixel"
            ? parsed.unit
            : undefined;
        return { x: parsed.x, y: parsed.y, unit };
      }
      if (
        Array.isArray(parsed.point) &&
        parsed.point.length >= 2 &&
        typeof parsed.point[0] === "number" &&
        typeof parsed.point[1] === "number"
      ) {
        return { x: parsed.point[0], y: parsed.point[1] };
      }
    } catch {
      // Fallback to regex matching below
    }
  }

  const pairMatch =
    /[[(]\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*[\])]/.exec(trimmed);
  if (pairMatch) {
    const x = Number(pairMatch[1]);
    const y = Number(pairMatch[2]);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { x, y };
    }
  }

  const xyMatch =
    /x\s*[:=]\s*(-?\d+(?:\.\d+)?)[,;\s]+y\s*[:=]\s*(-?\d+(?:\.\d+)?)/i.exec(
      trimmed,
    );
  if (xyMatch) {
    const x = Number(xyMatch[1]);
    const y = Number(xyMatch[2]);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { x, y };
    }
  }

  return undefined;
}

/**
 * Fast, lightweight synthetic in-memory driver used when no custom driverFactory is given and
 * real OS process launching is not requested (or as a fallback in headless test environments).
 */
export class SyntheticRealmDriver implements RealmDriver {
  readonly kind: ComputerRealmKind;
  readonly tier: ComputerIsolationTier;
  readonly fileBroker: FileBrokerPolicy;
  #title: string;
  #target: string;
  #viewport: ViewportSize;
  #watched = false;
  #closed = false;
  #picker: ComputerPickerState;
  readonly #pngBase64Cache = new Map<string, string>();

  constructor(options: {
    kind: ComputerRealmKind;
    target: string;
    title?: string | undefined;
    viewport?: ViewportSize | undefined;
    fileBroker: FileBrokerPolicy;
  }) {
    this.kind = options.kind;
    this.tier = options.kind === "browser" ? "cdp" : "hidden_desktop";
    this.fileBroker = options.fileBroker;
    this.#target = options.target;
    this.#title =
      options.title ??
      (options.kind === "browser"
        ? `Browser (${options.target})`
        : `App (${options.target})`);
    this.#viewport = {
      width: options.viewport?.width ?? 1280,
      height: options.viewport?.height ?? 800,
      scaleFactor: options.viewport?.scaleFactor ?? 1,
    };
    this.#picker = {
      status: "idle",
      files: [],
      updatedAt: Date.now(),
    };
  }

  title(): string {
    return this.#title;
  }

  target(): string {
    return this.#target;
  }

  viewport(): ViewportSize {
    return { ...this.#viewport };
  }

  get isWatched(): boolean {
    return this.#watched;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  #renderPngBase64(width: number, height: number): string {
    // Keep synthetic dimensions small in memory while reporting full logical viewport metadata
    const sampleW = Math.max(1, Math.min(32, width));
    const sampleH = Math.max(1, Math.min(32, height));
    const key = `${String(sampleW)}x${String(sampleH)}`;
    const cached = this.#pngBase64Cache.get(key);
    if (cached !== undefined) return cached;
    const png = createSolidPngBuffer(
      sampleW,
      sampleH,
      [32, 44, 64, 255],
    ).toString("base64");
    this.#pngBase64Cache.set(key, png);
    return png;
  }

  async observe(options?: {
    crop?: CropBox | undefined;
    format?: "png" | "jpeg" | "webp" | undefined;
  }): Promise<RealmObservation> {
    if (this.#closed) {
      throw new Error("SyntheticRealmDriver is closed");
    }
    if (options?.crop !== undefined) {
      const cropRect = resolveCropRect(options.crop, this.#viewport);
      return {
        mimeType: "image/png",
        data: this.#renderPngBase64(cropRect.width, cropRect.height),
        viewport: {
          width: cropRect.width,
          height: cropRect.height,
          scaleFactor: this.#viewport.scaleFactor,
        },
        cropRect,
      };
    }
    return {
      mimeType: "image/png",
      data: this.#renderPngBase64(this.#viewport.width, this.#viewport.height),
      viewport: { ...this.#viewport },
    };
  }

  async step(
    action: ComputerMicroAction,
    ctx: { signal: AbortSignal; clipboard: VirtualClipboard },
  ): Promise<RealmStepResult | void> {
    if (ctx.signal.aborted) return;
    if (action.kind === "type") {
      return {
        summary: `Typed "${action.text}"${action.submit ? " + Enter" : ""}`,
      };
    }
    if (action.kind === "key") {
      const lower = action.key.toLowerCase();
      if (lower === "control+c" || lower === "ctrl+c" || lower === "meta+c") {
        if (ctx.clipboard.readText() === "") {
          ctx.clipboard.writeText(this.#title);
        }
      }
      return { summary: `Pressed key ${action.key}` };
    }
    if (action.kind === "wait") {
      if (action.durationMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(action.durationMs, 50));
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
      return { summary: `Waited ${String(action.durationMs)}ms` };
    }
    return undefined;
  }

  async stageFiles(files: string[]): Promise<ComputerPickerState> {
    this.#picker = {
      status: files.length > 0 ? "armed" : "idle",
      files: files.map((f) => path.basename(f)),
      updatedAt: Date.now(),
    };
    return { ...this.#picker, files: [...this.#picker.files] };
  }

  async resolvePicker(files: string[]): Promise<ComputerPickerState> {
    this.#picker = {
      status: "intercepted_silent",
      files: files.map((f) => path.basename(f)),
      updatedAt: Date.now(),
    };
    return { ...this.#picker, files: [...this.#picker.files] };
  }

  setWatched(watched: boolean): void {
    this.#watched = watched;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#watched = false;
  }
}

export class ComputerService {
  readonly manager: RealmManager;
  readonly mirrors: ComputerRealmMirrors | undefined;
  readonly machineId: string;

  #groundingModel: string | null;
  readonly #capabilitiesOption:
    | ComputerMachineCapabilities
    | (() => ComputerMachineCapabilities)
    | undefined;
  readonly #probeOptions: ProbeWindowsCapabilitiesOptions | undefined;
  #cachedCapabilities: ComputerMachineCapabilities | undefined;
  readonly #modelsSource:
    | KernelModels
    | (() => KernelModels | undefined)
    | undefined;
  readonly #onGenerated:
    | ((meta: SessionMeta, message: AssistantMessage) => void)
    | undefined;
  readonly #driverFactory: ComputerDriverFactory | undefined;
  readonly #fileBrokerOptions: FileBrokerPolicyOptions | undefined;
  readonly #askUser: ComputerAskUserCallback | undefined;
  readonly #sendChat:
    | ((conversationId: string, text: string) => void | Promise<void>)
    | undefined;
  readonly #latestReply:
    | ((conversationId: string) => string | undefined)
    | undefined;
  readonly #promoteTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #overlays = new Map<
    string,
    { poll: ReturnType<typeof setInterval> }
  >();
  readonly #changedListeners = new Set<() => void>();
  readonly #realmAddedListeners = new Set<(realm: ManagedRealm) => void>();
  readonly #bindings = new Map<string, RealmBindingMetadata>();
  readonly #realmPolicies = new Map<string, FileBrokerPolicy>();
  readonly #inFlightApprovedPaths = new Set<string>();
  /** `computer/screens.json`: which desktop holds which live app, across host restarts. */
  readonly #screensPath: string | undefined;

  constructor(options: ComputerServiceOptions = {}) {
    this.machineId =
      options.machineId ??
      options.manager?.machineId ??
      options.managerOptions?.machineId ??
      "local";
    this.manager =
      options.manager ??
      new RealmManager({
        ...options.managerOptions,
        machineId: this.machineId,
      });
    this.mirrors = options.mirrors;
    this.#groundingModel = options.groundingModel ?? null;
    this.#capabilitiesOption = options.capabilities;
    this.#probeOptions = options.probeOptions;
    this.#modelsSource = options.models;
    this.#onGenerated = options.onGenerated;
    this.#driverFactory = options.driverFactory;
    this.#fileBrokerOptions = options.fileBrokerOptions;
    this.#askUser = options.askUser;
    this.#sendChat = options.sendChat;
    this.#latestReply = options.latestReply;
    this.#screensPath =
      options.dataDir === undefined
        ? undefined
        : path.join(options.dataDir, "computer", "screens.json");
    if (options.changed !== undefined) {
      this.#changedListeners.add(options.changed);
    }
  }

  /** Subscribe to service state changes (`realms`, `capabilities`, `groundingModel`). */
  onChange(listener: () => void): () => void {
    this.#changedListeners.add(listener);
    return () => {
      this.#changedListeners.delete(listener);
    };
  }

  /** Publish the current state again, for changes that happened outside a request (a restore). */
  refresh(): void {
    this.#notifyChanged();
  }

  /** Subscribe to newly registered local `ManagedRealm` instances. */
  onRealmAdded(listener: (realm: ManagedRealm) => void): () => void {
    this.#realmAddedListeners.add(listener);
    return () => {
      this.#realmAddedListeners.delete(listener);
    };
  }

  #notifyChanged(): void {
    for (const listener of this.#changedListeners) {
      listener();
    }
  }

  /** Current optional fast grounder model ID (or `null` when unset). */
  groundingModel(): string | null {
    return this.#groundingModel;
  }

  /** Set or clear the optional fast grounder model ID. */
  setGroundingModel(modelId: string | null | undefined): string | null {
    const trimmed =
      typeof modelId === "string" && modelId.trim() !== ""
        ? modelId.trim()
        : null;
    this.#groundingModel = trimmed;
    this.#notifyChanged();
    return this.#groundingModel;
  }

  /** Read local machine Computer Use capabilities (`probeWindowsCapabilities`). */
  localCapabilities(): ComputerMachineCapabilities {
    if (typeof this.#capabilitiesOption === "function") {
      return this.#capabilitiesOption();
    }
    if (this.#capabilitiesOption !== undefined) {
      return this.#capabilitiesOption;
    }
    if (this.#cachedCapabilities === undefined) {
      const probed = probeWindowsCapabilities({
        machineId: this.machineId,
        ...this.#probeOptions,
      });
      this.#cachedCapabilities = {
        machineId: probed.machineId,
        os: probed.os,
        ...(probed.edition === undefined ? {} : { edition: probed.edition }),
        browser: probed.browser,
        ...(probed.browserExecutable === undefined
          ? {}
          : { browserExecutable: probed.browserExecutable }),
        windowsChildSession: probed.windowsChildSession,
        windowsHiddenDesktop: probed.windowsHiddenDesktop,
      };
    }
    return this.#cachedCapabilities;
  }

  /** Aggregate local and remote daemon machine capabilities. */
  capabilities(): ComputerMachineCapabilities[] {
    const local = this.localCapabilities();
    const remote = this.mirrors?.capabilities() ?? [];
    const byMachine = new Map<string, ComputerMachineCapabilities>();
    byMachine.set(local.machineId, local);
    for (const cap of remote) {
      byMachine.set(cap.machineId, cap);
    }
    return [...byMachine.values()];
  }

  /** Aggregate local and remote daemon realm views. */
  realms(): ComputerRealmView[] {
    const localViews = this.manager.views();
    const remoteViews = this.mirrors?.realms() ?? [];
    const seen = new Set<string>();
    const out: ComputerRealmView[] = [];
    for (const view of localViews) {
      seen.add(view.id);
      out.push(view);
    }
    for (const view of remoteViews) {
      if (!seen.has(view.id)) {
        seen.add(view.id);
        out.push(view);
      }
    }
    return out;
  }

  /** Verify that a model descriptor supports `"image"` input. */
  checkModelSupportsVision(
    model:
      | { id: string; input?: readonly ("text" | "image")[] | undefined }
      | undefined,
  ): VisionGateCheckResult {
    return checkModelSupportsVision(model);
  }

  /**
   * Resolve a session's model (or the configured `groundingModel`) against `models` and check
   * whether it supports `"image"` input.
   */
  verifyVisionForSession(options: {
    sessionModel?:
      | {
          provider?: string | undefined;
          modelId?: string | undefined;
          id?: string | undefined;
          input?: readonly ("text" | "image")[] | undefined;
        }
      | string
      | undefined;
    models?: KernelModels | undefined;
  }): VisionGateCheckResult {
    const models = options.models ?? this.#resolveModels();
    const resolveDescriptor = (
      raw:
        | {
            provider?: string | undefined;
            modelId?: string | undefined;
            id?: string | undefined;
            input?: readonly ("text" | "image")[] | undefined;
          }
        | string
        | undefined,
    ):
      | { id: string; input?: readonly ("text" | "image")[] | undefined }
      | undefined => {
      if (raw === undefined) return undefined;
      if (typeof raw === "string") {
        const parsed = parseModelId(raw);
        const found = models?.getModel(parsed.provider, parsed.modelId);
        if (found !== undefined) {
          return {
            id: `${parsed.provider}:${parsed.modelId}`,
            input: found.input,
          };
        }
        return { id: raw, input: undefined };
      }
      if (Array.isArray(raw.input)) {
        const id =
          raw.id ??
          (raw.provider && raw.modelId
            ? `${raw.provider}:${raw.modelId}`
            : (raw.modelId ?? "unknown"));
        return { id, input: raw.input };
      }
      const provider = raw.provider;
      const modelId = raw.modelId ?? raw.id;
      if (provider !== undefined && modelId !== undefined) {
        const found = models?.getModel(provider, modelId);
        if (found !== undefined) {
          return {
            id: `${provider}:${modelId}`,
            input: found.input,
          };
        }
        return { id: `${provider}:${modelId}`, input: undefined };
      }
      if (modelId !== undefined) {
        const parsed = parseModelId(modelId);
        const found = models?.getModel(parsed.provider, parsed.modelId);
        if (found !== undefined) {
          return {
            id: `${parsed.provider}:${parsed.modelId}`,
            input: found.input,
          };
        }
        return { id: modelId, input: undefined };
      }
      return undefined;
    };

    const primaryDescriptor = resolveDescriptor(options.sessionModel);
    const primaryCheck = checkModelSupportsVision(primaryDescriptor);
    if (primaryCheck.ok) {
      return primaryCheck;
    }

    if (this.#groundingModel !== null) {
      const grounderDescriptor = resolveDescriptor(this.#groundingModel);
      const grounderCheck = checkModelSupportsVision(grounderDescriptor);
      if (grounderCheck.ok) {
        return grounderCheck;
      }
    }

    return primaryCheck;
  }

  /**
   * Build a `FileBrokerPolicy` for a session/realm that routes out-of-workspace `"ask"` decisions
   * through the session's `AskRegistry` (`ask`) or the service's `askUser` callback.
   */
  createFileBrokerPolicy(options: {
    cwd?: string | undefined;
    meta?: SessionMeta | undefined;
    ask?: AskRegistry | undefined;
    askUser?: ComputerAskUserCallback | undefined;
    signal?: AbortSignal | undefined;
    extraOptions?: FileBrokerPolicyOptions | undefined;
  }): FileBrokerPolicy {
    const projectDir =
      options.extraOptions?.projectDir ??
      options.cwd ??
      options.meta?.cwd ??
      this.#fileBrokerOptions?.projectDir ??
      process.cwd();

    const askCallback: FileBrokerApprovalCallback = async (
      req: FileBrokerApprovalRequest,
    ): Promise<boolean> => {
      if (
        req.paths.length > 0 &&
        req.paths.every((p) => this.#inFlightApprovedPaths.has(p))
      ) {
        return true;
      }
      const questionId = `file_broker:${randomUUID()}`;
      const question = `Allow Computer Use ${req.mode} access to file(s) outside the workspace: ${req.paths.join(", ")}?`;
      const askOptions = ["allow", "deny"];

      const customAsk = options.askUser ?? this.#askUser;
      if (customAsk !== undefined) {
        const answer = await customAsk({
          questionId,
          question,
          options: askOptions,
          meta: options.meta,
          signal: options.signal,
        });
        return isApprovedAnswer(answer);
      }

      if (options.ask !== undefined) {
        const answer = await options.ask.ask(
          {
            questionId,
            question,
            options: askOptions,
          },
          options.signal === undefined ? {} : { signal: options.signal },
        );
        return isApprovedAnswer(answer);
      }

      if (this.#fileBrokerOptions?.askApproval !== undefined) {
        return await this.#fileBrokerOptions.askApproval(req);
      }

      return false;
    };

    return new FileBrokerPolicy({
      ...this.#fileBrokerOptions,
      ...options.extraOptions,
      projectDir,
      askApproval: askCallback,
    });
  }

  /** Find an existing open realm matching `(sessionId, kind, target)` if reusable. */
  findReusableRealm(request: {
    sessionId: string;
    kind: ComputerRealmKind;
    target: string;
  }): ManagedRealm | undefined {
    const requestedNorm = normalizeReuseTarget(request.kind, request.target);
    for (const realm of this.manager.list()) {
      if (
        realm.controller !== "closed" &&
        realm.sessionId === request.sessionId &&
        realm.driver.kind === request.kind &&
        normalizeReuseTarget(request.kind, realm.driver.target()) ===
          requestedNorm
      ) {
        return realm;
      }
    }
    return undefined;
  }

  /**
   * Open or reuse an isolated `browser` or `app` realm and bind it to
   * `(sessionId, agentId, agentName, conversationId, taskId, machineId)`.
   */
  async openRealm(
    request: OpenRealmRequest & {
      ask?: AskRegistry | undefined;
      askUser?: ComputerAskUserCallback | undefined;
      meta?: SessionMeta | undefined;
    },
  ): Promise<{ realm: ManagedRealm; reused: boolean }> {
    if (request.kind === "app") {
      const check = checkProcessTargetAllowed(request.target);
      if (!check.allowed) {
        throw new Error(
          `${check.code}: target "${request.target}" is blocked by the sensitive process denylist (${check.matchedEntry})`,
        );
      }
    }

    if (request.reuse !== false && request.id === undefined) {
      const existing = this.findReusableRealm({
        sessionId: request.sessionId,
        kind: request.kind,
        target: request.target,
      });
      if (existing !== undefined) {
        return { realm: existing, reused: true };
      }
    }

    // A relaunch that asked for its own arguments or script is a second instance of the same app.
    // The one already open is never closed for it: that window may hold work that was never saved,
    // and ending a Computer Use app is the user's decision alone.
    if (request.reuse === false && request.id === undefined) {
      const running = this.findReusableRealm({
        sessionId: request.sessionId,
        kind: request.kind,
        target: request.target,
      });
      if (running !== undefined) {
        throw new Error(
          `"${request.target}" is already open in realm "${running.id}". Starting it again would mean ending that window, which may hold unsaved work — ask the user to close it first, or keep using the realm that is open.`,
        );
      }
    }

    const machineId = request.machineId ?? this.machineId;
    const fileBroker = this.createFileBrokerPolicy({
      cwd: request.cwd ?? request.meta?.cwd,
      meta: request.meta,
      ask: request.ask,
      askUser: request.askUser,
    });

    const capabilities = this.localCapabilities();
    let driver: RealmDriver;
    if (request.driver !== undefined) {
      driver = request.driver;
    } else if (this.#driverFactory !== undefined) {
      driver = await this.#driverFactory({
        ...request,
        machineId,
        fileBroker,
        capabilities,
      });
    } else {
      driver = new SyntheticRealmDriver({
        kind: request.kind,
        target: request.target,
        title: request.title,
        viewport: request.viewport,
        fileBroker,
      });
    }

    const metadata: ManagedRealmMetadata = {
      id: request.id,
      machineId,
      sessionId: request.sessionId,
      conversationId: request.conversationId,
      taskId: request.taskId,
      agentId: request.agentId,
      agentName: request.agentName,
      initialController: request.initialController ?? "agent",
    };

    const realm = this.manager.register(driver, metadata);
    bindRealmIfAny(driver, realm);
    this.#rememberScreen(realm);

    this.#bindings.set(realm.id, {
      sessionId: request.sessionId,
      agentId: request.agentId,
      agentName: request.agentName,
      conversationId: request.conversationId,
      taskId: request.taskId,
      machineId,
      cwd: request.cwd ?? request.meta?.cwd,
    });
    this.#realmPolicies.set(realm.id, fileBroker);

    realm.onState(() => {
      this.#notifyChanged();
    });

    for (const listener of this.#realmAddedListeners) {
      listener(realm);
    }
    this.#notifyChanged();

    return { realm, reused: false };
  }

  /** Register an existing `RealmDriver` directly with binding metadata. */
  registerDriver(
    driver: RealmDriver,
    metadata: ManagedRealmMetadata & { cwd?: string | undefined } = {},
  ): ManagedRealm {
    const realm = this.manager.register(driver, {
      ...metadata,
      machineId: metadata.machineId ?? this.machineId,
    });
    bindRealmIfAny(driver, realm);
    this.#bindings.set(realm.id, {
      sessionId: realm.sessionId,
      agentId: realm.agentId,
      agentName: realm.agentName,
      conversationId: realm.conversationId,
      taskId: realm.taskId,
      machineId: realm.machineId,
      cwd: metadata.cwd,
    });
    realm.onState(() => {
      this.#notifyChanged();
    });
    for (const listener of this.#realmAddedListeners) {
      listener(realm);
    }
    this.#notifyChanged();
    return realm;
  }

  /** Retrieve binding metadata for a realm. */
  bindingOf(realmId: string): RealmBindingMetadata | undefined {
    return this.#bindings.get(realmId);
  }

  /** Retrieve a local `ManagedRealm` by ID, or throw if unknown. */
  requireLocalRealm(realmId: string): ManagedRealm {
    return this.manager.require(realmId);
  }

  /** Capture a clean screenshot observation (with optional GroundCascade `crop`). */
  async observe(
    realmId: string,
    options?: {
      crop?: CropBox | undefined;
      format?: "png" | "jpeg" | "webp" | undefined;
    },
  ): Promise<{ observation: RealmObservation; view: ComputerRealmView }> {
    const realm = this.manager.require(realmId);
    const observation = await realm.observe(options);
    return {
      observation,
      view: realm.view(),
    };
  }

  /** Execute a batch of 1..8 micro-actions on a realm. */
  async act(
    realmId: string,
    actions: readonly ComputerMicroAction[],
    options: RealmActOptions = {},
  ): Promise<RealmActResult> {
    const realm = this.manager.require(realmId);
    return await realm.act(actions, options);
  }

  /**
   * Authorize and stage files for the realm's silent file picker through `FileBrokerPolicy`
   * (routing out-of-workspace paths through `ask` / `Inbox`).
   */
  async stageFiles(
    realmId: string,
    files: readonly string[],
    options: {
      mode?: FileBrokerMode | undefined;
      cwd?: string | undefined;
      meta?: SessionMeta | undefined;
      ask?: AskRegistry | undefined;
      askUser?: ComputerAskUserCallback | undefined;
      signal?: AbortSignal | undefined;
    } = {},
  ): Promise<{
    picker: ComputerPickerState;
    allowedPaths: string[];
    asked: boolean;
  }> {
    const realm = this.manager.require(realmId);
    const binding = this.#bindings.get(realmId);
    const policy = this.createFileBrokerPolicy({
      cwd: options.cwd ?? binding?.cwd ?? options.meta?.cwd,
      meta: options.meta,
      ask: options.ask,
      askUser: options.askUser,
      signal: options.signal,
    });

    const auth = await policy.authorizeFiles(files, options.mode ?? "read");
    for (const p of auth.allowed) {
      this.#inFlightApprovedPaths.add(p);
    }
    try {
      const picker = await realm.stageFiles(auth.allowed);
      this.#notifyChanged();
      return {
        picker,
        allowedPaths: auth.allowed,
        asked: auth.asked,
      };
    } finally {
      for (const p of auth.allowed) {
        this.#inFlightApprovedPaths.delete(p);
      }
    }
  }

  /**
   * Authorize and resolve a pending silent file picker through `FileBrokerPolicy`
   * (routing out-of-workspace paths through `ask` / `Inbox`).
   */
  async resolvePicker(
    realmId: string,
    files: readonly string[],
    options: {
      mode?: FileBrokerMode | undefined;
      cwd?: string | undefined;
      meta?: SessionMeta | undefined;
      ask?: AskRegistry | undefined;
      askUser?: ComputerAskUserCallback | undefined;
      signal?: AbortSignal | undefined;
    } = {},
  ): Promise<{
    picker: ComputerPickerState;
    allowedPaths: string[];
    asked: boolean;
  }> {
    if (this.mirrors?.owns(realmId)) {
      const picker = (await this.mirrors.forward(realmId, "resolvePicker", {
        files: [...files],
      })) as ComputerPickerState;
      this.#notifyChanged();
      return {
        picker,
        allowedPaths: [...files],
        asked: false,
      };
    }

    const realm = this.manager.require(realmId);
    const binding = this.#bindings.get(realmId);
    const policy = this.createFileBrokerPolicy({
      cwd: options.cwd ?? binding?.cwd ?? options.meta?.cwd,
      meta: options.meta,
      ask: options.ask,
      askUser: options.askUser,
      signal: options.signal,
    });

    const auth = await policy.authorizeFiles(files, options.mode ?? "read");
    for (const p of auth.allowed) {
      this.#inFlightApprovedPaths.add(p);
    }
    try {
      const picker = await realm.resolvePicker(auth.allowed);
      this.#notifyChanged();
      return {
        picker,
        allowedPaths: auth.allowed,
        asked: auth.asked,
      };
    } finally {
      for (const p of auth.allowed) {
        this.#inFlightApprovedPaths.delete(p);
      }
    }
  }

  /** Read, write, or clear a realm's isolated `VirtualClipboard` without touching the host OS clipboard. */
  clipboard(
    realmId: string,
    operation:
      | { action: "read" }
      | { action: "write"; payload: VirtualClipboardPayload | string }
      | { action: "clear" },
  ): VirtualClipboardSnapshot {
    const realm = this.manager.require(realmId);
    switch (operation.action) {
      case "read":
        return realm.clipboard.snapshot();
      case "write":
        return realm.clipboard.write(operation.payload);
      case "clear":
        return realm.clipboard.clear();
    }
  }

  /**
   * Close a realm (local or remote mirror) and release its resources.
   *
   * Closing releases the desktop and the realm's bookkeeping but leaves the app running: a Computer
   * Use app may be holding work that was never saved, so ending it is the user's decision. Pass
   * `endApp` only when the user explicitly confirmed it.
   */
  async closeRealm(
    realmId: string,
    reason?: string,
    options: { endApp?: boolean } = {},
  ): Promise<ComputerRealmView> {
    if (this.mirrors?.owns(realmId)) {
      const result = (await this.mirrors.forward(realmId, "close", {
        ...(reason === undefined ? {} : { reason }),
        ...(options.endApp === true ? { endApp: true } : {}),
      })) as ComputerRealmView;
      this.#notifyChanged();
      return result;
    }
    const realm = this.manager.require(realmId);
    if (realm.isPromoted) {
      await this.demoteRealm(realmId, "Realm closed");
    }
    if (options.endApp === true) {
      const driver = realm.driver as {
        terminateApp?: () => Promise<void> | undefined;
      };
      await driver.terminateApp?.();
    }
    const view = await realm.close(reason);
    this.#forgetScreen(realmId);
    this.#notifyChanged();
    return view;
  }

  /**
   * Remember that this realm owns a desktop with a live app, so a later host can adopt it instead
   * of leaving the user an app they cannot reach.
   */
  #rememberScreen(realm: ManagedRealm): void {
    if (this.#screensPath === undefined) return;
    const driver = realm.driver as { desktopName?: string | undefined };
    if (realm.view().kind !== "app" || driver.desktopName === undefined) return;
    const view = realm.view();
    const records = this.#readScreens().filter(
      (record) => record.realmId !== realm.id,
    );
    records.push({
      realmId: realm.id,
      desktopName: driver.desktopName,
      target: view.target,
      title: view.title,
      viewport: {
        width: view.viewport.width,
        height: view.viewport.height,
        scaleFactor: view.viewport.scaleFactor ?? 1,
      },
      sessionId: realm.sessionId,
      conversationId: realm.conversationId,
      agentId: realm.agentId,
      agentName: realm.agentName,
      taskId: realm.taskId,
      machineId: realm.machineId,
      openedAt: Date.now(),
    });
    this.#writeScreens(records);
  }

  #forgetScreen(realmId: string): void {
    if (this.#screensPath === undefined) return;
    const records = this.#readScreens();
    const kept = records.filter((record) => record.realmId !== realmId);
    if (kept.length !== records.length) this.#writeScreens(kept);
  }

  #readScreens(): PersistedScreen[] {
    const file = this.#screensPath;
    if (file === undefined) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (item): item is PersistedScreen =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as PersistedScreen).realmId === "string" &&
          typeof (item as PersistedScreen).desktopName === "string" &&
          typeof (item as PersistedScreen).target === "string",
      );
    } catch {
      return [];
    }
  }

  #writeScreens(records: readonly PersistedScreen[]): void {
    const file = this.#screensPath;
    if (file === undefined) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    } catch {
      // Losing the record only costs the ability to adopt the app; the app itself is untouched.
    }
  }

  /**
   * Adopt the apps that are still running on desktops a previous host created.
   *
   * Runs at startup. Nothing is launched and nothing is ended: each surviving window simply gets its
   * realm back, so the panel can show it (and the user can put it back on screen) after a restart
   * instead of the app becoming unreachable.
   */
  async restoreScreens(): Promise<number> {
    const records = this.#readScreens();
    if (records.length === 0) return 0;
    const kept: PersistedScreen[] = [];
    let restored = 0;
    for (const record of records) {
      if (this.manager.list().some((realm) => realm.id === record.realmId)) {
        kept.push(record);
        continue;
      }
      if (this.#driverFactory === undefined) {
        kept.push(record);
        continue;
      }
      try {
        const driver = await this.#driverFactory({
          kind: "app",
          target: record.target,
          title: record.title,
          viewport: record.viewport,
          attachTo: record.desktopName,
          sessionId: record.sessionId,
          conversationId: record.conversationId,
          agentId: record.agentId,
          agentName: record.agentName,
          taskId: record.taskId,
          machineId: record.machineId,
          fileBroker: this.createFileBrokerPolicy({}),
          capabilities: this.localCapabilities(),
        });
        const realm = this.manager.register(driver, {
          id: record.realmId,
          machineId: record.machineId,
          sessionId: record.sessionId,
          conversationId: record.conversationId,
          agentId: record.agentId,
          agentName: record.agentName,
          taskId: record.taskId,
        });
        bindRealmIfAny(driver, realm);
        this.#bindings.set(realm.id, {
          sessionId: record.sessionId,
          agentId: record.agentId,
          agentName: record.agentName,
          conversationId: record.conversationId,
          taskId: record.taskId,
          machineId: record.machineId,
        });
        for (const listener of this.#realmAddedListeners) listener(realm);
        kept.push(record);
        restored += 1;
      } catch {
        // The app or its desktop is gone; the record is dropped below.
      }
    }
    if (kept.length !== records.length) this.#writeScreens(kept);
    if (restored > 0) this.#notifyChanged();
    return restored;
  }

  /** Close all local realms. Apps are left running: they may hold work nobody saved. */
  async closeAll(): Promise<void> {
    for (const realm of this.manager.list()) {
      if (realm.isPromoted) {
        await this.demoteRealm(realm.id, "Host shutting down").catch(() => {});
      }
    }
    await this.manager.closeAll();
    this.#notifyChanged();
  }

  /** Dispatch a `ComputerAction` to either a local realm or a remote mirrored realm. */
  async dispatchAction(
    realmId: string,
    action: ComputerAction,
    args: {
      reason?: string | undefined;
      input?: ComputerUserInput | undefined;
      files?: string[] | undefined;
      /** Set only by the user's own "end the app" confirmation; never by an agent. */
      endApp?: boolean | undefined;
    } = {},
  ): Promise<ComputerRealmView | ComputerPickerState> {
    if (this.mirrors?.owns(realmId)) {
      return (await this.mirrors.forward(realmId, action, args)) as
        | ComputerRealmView
        | ComputerPickerState;
    }
    const realm = this.manager.require(realmId);
    const reason =
      typeof args.reason === "string" && args.reason.trim() !== ""
        ? args.reason
        : undefined;
    switch (action) {
      case "takeover":
        return realm.takeover(reason);
      case "release":
        return realm.release(reason);
      case "pause":
        return realm.pause(reason);
      case "resume":
        return realm.resume(reason);
      case "stop":
        return realm.stop(reason);
      case "input": {
        if (args.input === undefined) {
          throw new Error(`computer.${realmId}.input needs input`);
        }
        await realm.userInput(args.input);
        return realm.view();
      }
      case "resolvePicker": {
        if (!Array.isArray(args.files)) {
          throw new TypeError(`computer.${realmId}.resolvePicker needs files`);
        }
        const resolved = await this.resolvePicker(realmId, args.files);
        return resolved.picker;
      }
      case "close":
        return await this.closeRealm(realmId, reason, {
          endApp: args.endApp === true,
        });
      case "promote":
        return await this.promoteRealm(realmId);
      case "demote":
        return await this.demoteRealm(realmId);
    }
  }

  /** How long a promoted realm may keep the user's screen before it hands it back. */
  static readonly MAX_PROMOTED_MS = 30 * 60 * 1000;

  /**
   * Put this realm's desktop on the user's screen.
   *
   * Taking the screen is a takeover by definition — the human is now in front of the keyboard — so
   * control moves to `user` while it lasts, and a timer hands the screen back even if everybody
   * forgets. Only a hidden-desktop app realm can do it: a browser realm is headless, and a
   * child-session realm already has a window of its own.
   */
  async promoteRealm(realmId: string): Promise<ComputerRealmView> {
    if (this.mirrors?.owns(realmId)) {
      throw new Error(
        `Realm "${realmId}" runs on another machine and cannot take this screen`,
      );
    }
    const realm = this.manager.require(realmId);
    const driver = realm.driverForPromote();
    if (driver === undefined) {
      throw new Error(
        `Realm "${realmId}" (${realm.view().kind} / ${realm.view().tier}) cannot be brought to the screen`,
      );
    }
    // Already on the user's screen: answer with the state they can see rather than stacking a
    // second overlay and a second time limit on the same realm.
    if (realm.isPromoted) {
      return realm.view();
    }
    realm.takeover("Brought to your screen");
    let paths: { chatFile: string; statusFile: string } | undefined;
    try {
      paths = await driver.promote();
    } catch (error) {
      realm.release("Could not switch the screen");
      // Nothing is left to look at: the app or its desktop died while the realm stayed open. Close
      // it, so the panel collapses to the "closed" row instead of offering a screen nobody can use.
      if (
        error instanceof HiddenDesktopError &&
        error.code === "desktop_closed"
      ) {
        await this.closeRealm(realmId, "The app is no longer running").catch(
          () => undefined,
        );
      }
      throw error;
    }
    realm.setPromoted(true);
    if (paths !== undefined) {
      this.#watchOverlay(realm, paths);
    }
    const timer = setTimeout(() => {
      void this.demoteRealm(realmId, "Promotion time limit reached").catch(
        () => {},
      );
    }, ComputerService.MAX_PROMOTED_MS);
    timer.unref?.();
    this.#promoteTimers.set(realmId, timer);
    this.#notifyChanged();
    return realm.view();
  }

  /** Hand the user's screen back and return control to the agent. */
  async demoteRealm(
    realmId: string,
    reason = "Back to your desktop",
  ): Promise<ComputerRealmView> {
    const realm = this.manager.require(realmId);
    const timer = this.#promoteTimers.get(realmId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#promoteTimers.delete(realmId);
    }
    const overlay = this.#overlays.get(realmId);
    if (overlay !== undefined) {
      this.#overlays.delete(realmId);
      clearInterval(overlay.poll);
    }
    const driver = realm.driverForPromote();
    try {
      await driver?.demote();
    } finally {
      realm.setPromoted(false);
      if (realm.view().controller === "user") {
        realm.release(reason);
      }
      this.#notifyChanged();
    }
    return realm.view();
  }

  /** Read the overlay's chat file and forward what the user typed to its conversation. */
  #watchOverlay(
    realm: ManagedRealm,
    paths: { chatFile: string; statusFile: string },
  ): void {
    const conversationId = realm.view().conversationId;
    let offset = 0;
    let busy = false;
    const poll = setInterval(() => {
      if (busy) return;
      busy = true;
      void (async () => {
        try {
          const text = await readFile(paths.chatFile, "utf8");
          if (text.length > offset) {
            const chunk = text.slice(offset);
            offset = text.length;
            for (const line of chunk.split("\n")) {
              const trimmed = line.trim();
              if (trimmed === "") continue;
              let payload: { text?: string } = {};
              try {
                payload = JSON.parse(trimmed) as { text?: string };
              } catch {
                continue;
              }
              const message = payload.text ?? "";
              if (message === "__switch_back__") {
                await this.demoteRealm(
                  realm.id,
                  "Switched back from the overlay",
                );
                continue;
              }
              if (message === "__release__") {
                realm.release("Handed back from overlay");
                this.#notifyChanged();
                continue;
              }
              if (message === "__takeover__") {
                realm.takeover("Taken over from overlay");
                this.#notifyChanged();
                continue;
              }
              if (message === "__pause__") {
                realm.pause("Paused from overlay");
                this.#notifyChanged();
                continue;
              }
              if (message === "__resume__") {
                realm.resume("Resumed from overlay");
                this.#notifyChanged();
                continue;
              }
              if (message !== "" && conversationId !== undefined) {
                await this.#sendChat?.(conversationId, message);
              }
            }
          }
          const rawReply =
            conversationId !== undefined
              ? this.#latestReply?.(conversationId)
              : undefined;
          const reply =
            rawReply !== undefined && rawReply.trim() !== ""
              ? rawReply.replace(/\s+/gu, " ").trim().slice(0, 72)
              : undefined;
          const statusPayload = JSON.stringify({
            controller: realm.view().controller,
            status: this.#overlayStatus(realm),
            ...(reply === undefined ? {} : { reply }),
          });
          await writeFile(paths.statusFile, `${statusPayload}\n`, "utf8");
        } catch {
          // The overlay may be gone, or the file not written yet; the next tick retries.
        } finally {
          busy = false;
        }
      })();
    }, 500);
    poll.unref?.();
    this.#overlays.set(realm.id, { poll });
  }

  #overlayStatus(realm: ManagedRealm): string {
    const view = realm.view();
    switch (view.controller) {
      case "user":
        return "你正在操作 · 输入框可直接和 Agent 说话";
      case "paused":
        return "Agent 已暂停";
      case "closed":
        return "此域已关闭";
      default:
        return "Agent 正在工作";
    }
  }

  /**
   * Delegate a high-frequency GroundCascade localization call to the configured `groundingModel`
   * (or specified model) via `KernelModels` and record its token consumption to `onGenerated`
   * so the agent's `usage` table accounts for every grounding token.
   */
  async locateWithGrounder(
    request: GrounderLocateRequest & {
      models?: KernelModels | undefined;
      modelId?: string | undefined;
    },
  ): Promise<GrounderLocateResult> {
    const targetModelId = request.modelId ?? this.#groundingModel;
    if (
      targetModelId === null ||
      targetModelId === undefined ||
      targetModelId.trim() === ""
    ) {
      throw new Error(
        "grounder_not_configured: no groundingModel is configured on ComputerService",
      );
    }

    const models = request.models ?? this.#resolveModels();
    if (models === undefined) {
      throw new Error(
        "grounder_models_unavailable: KernelModels is not available for grounder routing",
      );
    }

    const parsed = parseModelId(targetModelId);
    const model = models.getModel(parsed.provider, parsed.modelId);
    if (model === undefined) {
      throw new Error(
        `grounder_model_unavailable: ${parsed.provider}:${parsed.modelId}`,
      );
    }

    const visionCheck = checkModelSupportsVision({
      id: `${parsed.provider}:${parsed.modelId}`,
      input: model.input,
    });
    if (!visionCheck.ok) {
      throw new Error(visionCheck.message);
    }

    const systemPrompt =
      'You are a precision UI coordinate grounder. Locate the requested target element in the provided screenshot and respond with JSON {"x": <0..1000>, "y": <0..1000>, "unit": "normalized"}.';

    const context = {
      systemPrompt,
      messages: [
        {
          role: "user" as const,
          content: [
            {
              type: "image" as const,
              mimeType: request.image.mimeType,
              data: request.image.data,
            },
            {
              type: "text" as const,
              text: request.prompt,
            },
          ],
          timestamp: Date.now(),
        },
      ],
    };

    const stream = models.streamSimple(
      model,
      context as never,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    for await (const _event of stream) {
      // Consume stream events until settled
    }
    const message: AssistantMessage = await stream.result();

    // Record usage so every grounding call's tokens/cost are accounted for in the agent's usage table
    this.#onGenerated?.(request.meta, message);

    const rawText = Array.isArray(message.content)
      ? message.content
          .map((block) =>
            (block as { type?: string; text?: string }).type === "text"
              ? ((block as { text?: string }).text ?? "")
              : "",
          )
          .join("")
      : "";

    const parsedCoord = parseGroundedCoordinate(rawText);
    if (parsedCoord === undefined) {
      return {
        modelId: `${parsed.provider}:${parsed.modelId}`,
        rawText,
        message,
      };
    }

    const unit: CoordinateUnit = parsedCoord.unit ?? "normalized";
    const cropRect =
      request.crop !== undefined
        ? resolveCropRect(request.crop, request.viewport)
        : undefined;
    const localViewport: ViewportSize =
      cropRect !== undefined
        ? { width: cropRect.width, height: cropRect.height }
        : request.viewport;

    const maxX =
      unit === "normalized"
        ? NORMALIZED_MAX
        : unit === "percent"
          ? PERCENT_MAX
          : localViewport.width;
    const maxY =
      unit === "normalized"
        ? NORMALIZED_MAX
        : unit === "percent"
          ? PERCENT_MAX
          : localViewport.height;

    const localNormalized: Point2D = {
      x: Math.round(
        (Math.max(0, Math.min(maxX, parsedCoord.x)) / Math.max(1, maxX)) *
          NORMALIZED_MAX,
      ),
      y: Math.round(
        (Math.max(0, Math.min(maxY, parsedCoord.y)) / Math.max(1, maxY)) *
          NORMALIZED_MAX,
      ),
    };

    const viewportPixel = toViewportPixels(
      { x: parsedCoord.x, y: parsedCoord.y },
      request.viewport,
      {
        unit,
        crop: cropRect,
        clamp: true,
      },
    );
    const viewportNormalized = toNormalizedPoint(
      viewportPixel,
      request.viewport,
    );

    return {
      modelId: `${parsed.provider}:${parsed.modelId}`,
      rawText,
      localNormalized,
      viewportNormalized,
      viewportPixel,
      message,
    };
  }

  #resolveModels(): KernelModels | undefined {
    if (typeof this.#modelsSource === "function") {
      return this.#modelsSource();
    }
    return this.#modelsSource;
  }
}
