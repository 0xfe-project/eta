/**
 * Computer Use (`computer`, `computer.<realmId>`): isolated browser and desktop application
 * realms, normalized 0..1000 coordinate math, silent file picker states, and single-writer
 * controller handoff.
 *
 * The model always receives clean screenshots (never painted with synthetic cursors), while the
 * web UI subscribes to `computer.<realmId>` to draw the clean frame underneath its own 60ms
 * linear vector cursor overlay.
 */

export const COMPUTER_REALM_KINDS = ["browser", "app"] as const;
export type ComputerRealmKind = (typeof COMPUTER_REALM_KINDS)[number];

export const COMPUTER_CONTROLLERS = [
  "agent",
  "user",
  "paused",
  "closed",
] as const;
export type ComputerController = (typeof COMPUTER_CONTROLLERS)[number];

export const COMPUTER_WINDOWS_TIERS = [
  "cdp",
  "child_session",
  "hidden_desktop",
  "sandbox",
  "unavailable",
] as const;
export type ComputerIsolationTier = (typeof COMPUTER_WINDOWS_TIERS)[number];

export const COMPUTER_CAPABILITY_STATES = [
  "ready",
  "unsupported_edition",
  "disabled",
  "service_session",
  "missing_binary",
  "unsupported_os",
] as const;
export type ComputerCapabilityState =
  (typeof COMPUTER_CAPABILITY_STATES)[number];

/** What a machine can run for Computer Use, reported in `computer` target's `capabilities` section. */
export interface ComputerMachineCapabilities {
  machineId: string;
  os: string;
  edition?: string | undefined;
  browser: ComputerCapabilityState;
  browserExecutable?: string | undefined;
  windowsChildSession: ComputerCapabilityState;
  windowsHiddenDesktop: ComputerCapabilityState;
}

/** Normalized coordinate range used by Computer Use models (`0..1000` inclusive). */
export const NORMALIZED_MAX = 1000;
/** Percentage coordinate range (`0..100` inclusive) used by lightweight grounders. */
export const PERCENT_MAX = 100;

export type CoordinateUnit = "normalized" | "percent" | "pixel";

export interface Point2D {
  x: number;
  y: number;
}

export interface ViewportSize {
  width: number;
  height: number;
  scaleFactor?: number | undefined;
}

/** A crop region in normalized `0..1000` or pixel coordinates for GroundCascade zoom checks. */
export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
  unit?: CoordinateUnit | undefined;
}

/** Pixel rectangle after resolving a `CropBox` against a `ViewportSize`. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const COMPUTER_CURSOR_KINDS = [
  "move",
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "type",
  "key",
  "wait",
] as const;
export type ComputerCursorKind = (typeof COMPUTER_CURSOR_KINDS)[number];

/**
 * Current or most recent pointer state of a realm, in normalized `0..1000` coordinates of the
 * full viewport so any client viewport size scales it identically without rounding drift.
 */
export interface ComputerCursorState {
  /** Normalized `0..1000` X coordinate. */
  x: number;
  /** Normalized `0..1000` Y coordinate. */
  y: number;
  kind: ComputerCursorKind;
  label?: string | undefined;
  at: number;
}

export const COMPUTER_PICKER_MODES = [
  "open_single",
  "open_multiple",
  "open_directory",
  "save",
] as const;
export type ComputerPickerMode = (typeof COMPUTER_PICKER_MODES)[number];

export const COMPUTER_PICKER_STATUSES = [
  "idle",
  "armed",
  "intercepted_silent",
  "pending_input",
  "awaiting_approval",
  "denied",
] as const;
export type ComputerPickerStatus = (typeof COMPUTER_PICKER_STATUSES)[number];

/** State of the realm's silent file picker broker. */
export interface ComputerPickerState {
  status: ComputerPickerStatus;
  mode?: ComputerPickerMode | undefined;
  /** Basenames or display paths of files armed or silently injected. */
  files: string[];
  accept?: string[] | undefined;
  title?: string | undefined;
  reason?: string | undefined;
  updatedAt: number;
}

/** Summary of an isolated Computer Use realm, published in `computer`'s `realms` section. */
export interface ComputerRealmView {
  id: string;
  kind: ComputerRealmKind;
  tier: ComputerIsolationTier;
  machineId: string;
  sessionId: string;
  conversationId?: string | undefined;
  taskId?: string | undefined;
  agentId?: string | undefined;
  agentName?: string | undefined;
  /** Window title or active page title. */
  title: string;
  /** URL for a browser realm, or executable name for an app realm. */
  target: string;
  viewport: ViewportSize;
  controller: ComputerController;
  /** Monotonically increasing lock epoch; increments on every controller transition or stop. */
  epoch: number;
  cursor: ComputerCursorState;
  picker: ComputerPickerState;
  /** Last one-line summary of what happened in the realm. */
  summary: string;
  /**
   * True while this realm's desktop is the one on the user's screen (`promote` switched to it).
   * Only a Windows app realm can be promoted; a browser realm stays headless.
   */
  promoted?: boolean | undefined;
  createdAt: number;
  updatedAt: number;
}

/** Ephemeral frame event payload emitted on `computer.<realmId>` only while watched. */
export interface ComputerFrameEvent {
  realmId: string;
  seq: number;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  /** Base64-encoded clean frame (no synthetic cursor painted). */
  data: string;
  viewport: ViewportSize;
  at: number;
}

/** Ephemeral cursor/action event emitted on `computer.<realmId>`. */
export interface ComputerCursorEvent extends ComputerCursorState {
  realmId: string;
  epoch: number;
}

/** Ephemeral file-picker notification emitted on `computer.<realmId>`. */
export interface ComputerPickerEvent extends ComputerPickerState {
  realmId: string;
}

/** One micro-action in a `computer_act` sequence (at most `MAX_MICRO_ACTIONS` per call). */
export const MAX_MICRO_ACTIONS = 8;

export type ComputerMicroAction =
  | {
      kind: "move";
      x: number;
      y: number;
      unit?: CoordinateUnit | undefined;
    }
  | {
      kind: "click" | "double_click" | "right_click";
      x: number;
      y: number;
      unit?: CoordinateUnit | undefined;
      button?: "left" | "right" | "middle" | undefined;
    }
  | {
      kind: "drag";
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      unit?: CoordinateUnit | undefined;
    }
  | {
      kind: "scroll";
      x?: number | undefined;
      y?: number | undefined;
      deltaX?: number | undefined;
      deltaY: number;
      unit?: CoordinateUnit | undefined;
    }
  | {
      kind: "type";
      text: string;
      submit?: boolean | undefined;
    }
  | {
      kind: "key";
      key: string;
    }
  | {
      kind: "wait";
      durationMs: number;
    };

/** Wire actions exposed on the `computer` and `computer.<realmId>` targets. */
export const COMPUTER_ACTIONS = [
  "takeover",
  "release",
  "pause",
  "resume",
  "stop",
  "input",
  "resolvePicker",
  "promote",
  "demote",
  "close",
] as const;
export type ComputerAction = (typeof COMPUTER_ACTIONS)[number];

/** Manual user input forwarded from `<ComputerViewport />` while `controller === "user"`. */
export type ComputerUserInput =
  | {
      kind: "click" | "double_click" | "right_click" | "move";
      /** Normalized `0..1000` coordinates inside the viewport. */
      x: number;
      y: number;
    }
  | {
      kind: "drag";
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
    }
  | {
      kind: "scroll";
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
    }
  | {
      kind: "type";
      text: string;
    }
  | {
      kind: "key";
      key: string;
    };

/* ------------------------------------------------------------------ coordinate math */

function assertFinite(value: number, name: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Invalid ${name}: expected a finite number`);
  }
}

function validateViewport(viewport: ViewportSize): void {
  assertFinite(viewport.width, "viewport.width");
  assertFinite(viewport.height, "viewport.height");
  if (viewport.width <= 0 || viewport.height <= 0) {
    throw new RangeError(
      `Invalid viewport dimensions: ${String(viewport.width)}x${String(viewport.height)}`,
    );
  }
}

/** Clamp a numeric coordinate into `[min, max]`. */
export function clampCoordinate(
  value: number,
  min: number,
  max: number,
): number {
  assertFinite(value, "coordinate");
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Validate that a coordinate lies within the declared unit's bounds (throws on out-of-range
 * negative or >max values for normalized/percent/pixel units).
 */
export function validateCoordinate(
  point: Point2D,
  viewport: ViewportSize,
  unit: CoordinateUnit = "normalized",
): void {
  assertFinite(point.x, "point.x");
  assertFinite(point.y, "point.y");
  validateViewport(viewport);
  const maxX =
    unit === "normalized"
      ? NORMALIZED_MAX
      : unit === "percent"
        ? PERCENT_MAX
        : viewport.width;
  const maxY =
    unit === "normalized"
      ? NORMALIZED_MAX
      : unit === "percent"
        ? PERCENT_MAX
        : viewport.height;
  if (point.x < 0 || point.x > maxX || point.y < 0 || point.y > maxY) {
    throw new RangeError(
      `Coordinate (${String(point.x)}, ${String(point.y)}) is out of bounds for unit "${unit}" (0..${String(maxX)}, 0..${String(maxY)})`,
    );
  }
}

/**
 * Convert a coordinate in `normalized` (`0..1000`), `percent` (`0..100`), or `pixel` space
 * into physical viewport pixels, optionally offset inside a resolved `crop` rectangle
 * (GroundCascade zoomed-view refinement).
 */
export function toViewportPixels(
  point: Point2D,
  viewport: ViewportSize,
  options: {
    unit?: CoordinateUnit | undefined;
    crop?: PixelRect | undefined;
    clamp?: boolean | undefined;
  } = {},
): Point2D {
  validateViewport(viewport);
  const unit = options.unit ?? "normalized";
  const targetWidth = options.crop ? options.crop.width : viewport.width;
  const targetHeight = options.crop ? options.crop.height : viewport.height;
  const offsetX = options.crop ? options.crop.x : 0;
  const offsetY = options.crop ? options.crop.y : 0;

  const targetViewport: ViewportSize = {
    width: targetWidth,
    height: targetHeight,
  };
  if (options.clamp !== true) {
    validateCoordinate(point, targetViewport, unit);
  }

  const maxX =
    unit === "normalized"
      ? NORMALIZED_MAX
      : unit === "percent"
        ? PERCENT_MAX
        : targetWidth;
  const maxY =
    unit === "normalized"
      ? NORMALIZED_MAX
      : unit === "percent"
        ? PERCENT_MAX
        : targetHeight;

  const rawX =
    options.clamp === true ? clampCoordinate(point.x, 0, maxX) : point.x;
  const rawY =
    options.clamp === true ? clampCoordinate(point.y, 0, maxY) : point.y;

  const localX =
    unit === "pixel"
      ? Math.round(rawX)
      : Math.round((rawX / maxX) * Math.max(1, targetWidth - 1));
  const localY =
    unit === "pixel"
      ? Math.round(rawY)
      : Math.round((rawY / maxY) * Math.max(1, targetHeight - 1));

  return {
    x: clampCoordinate(offsetX + localX, 0, Math.max(0, viewport.width - 1)),
    y: clampCoordinate(offsetY + localY, 0, Math.max(0, viewport.height - 1)),
  };
}

/**
 * Convert a physical viewport pixel coordinate into normalized `0..1000` integers.
 */
export function toNormalizedPoint(
  pixelPoint: Point2D,
  viewport: ViewportSize,
): Point2D {
  validateViewport(viewport);
  assertFinite(pixelPoint.x, "pixelPoint.x");
  assertFinite(pixelPoint.y, "pixelPoint.y");
  const clampedX = clampCoordinate(
    pixelPoint.x,
    0,
    Math.max(0, viewport.width - 1),
  );
  const clampedY = clampCoordinate(
    pixelPoint.y,
    0,
    Math.max(0, viewport.height - 1),
  );
  const denomX = Math.max(1, viewport.width - 1);
  const denomY = Math.max(1, viewport.height - 1);
  return {
    x: Math.round((clampedX / denomX) * NORMALIZED_MAX),
    y: Math.round((clampedY / denomY) * NORMALIZED_MAX),
  };
}

/**
 * Resolve a `CropBox` (in normalized `0..1000`, `percent`, or `pixel` units) into a bounded
 * non-empty `PixelRect` within `viewport`.
 */
export function resolveCropRect(
  crop: CropBox,
  viewport: ViewportSize,
): PixelRect {
  validateViewport(viewport);
  assertFinite(crop.x, "crop.x");
  assertFinite(crop.y, "crop.y");
  assertFinite(crop.width, "crop.width");
  assertFinite(crop.height, "crop.height");
  if (crop.width <= 0 || crop.height <= 0) {
    throw new RangeError("Crop width and height must be positive");
  }
  const unit = crop.unit ?? "normalized";
  const maxX =
    unit === "normalized"
      ? NORMALIZED_MAX
      : unit === "percent"
        ? PERCENT_MAX
        : viewport.width;
  const maxY =
    unit === "normalized"
      ? NORMALIZED_MAX
      : unit === "percent"
        ? PERCENT_MAX
        : viewport.height;
  if (
    crop.x < 0 ||
    crop.y < 0 ||
    crop.x >= maxX ||
    crop.y >= maxY ||
    crop.x + crop.width > maxX ||
    crop.y + crop.height > maxY
  ) {
    throw new RangeError("Crop box exceeds viewport bounds");
  }
  const x =
    unit === "pixel"
      ? Math.floor(crop.x)
      : Math.floor((crop.x / maxX) * viewport.width);
  const y =
    unit === "pixel"
      ? Math.floor(crop.y)
      : Math.floor((crop.y / maxY) * viewport.height);
  const right =
    unit === "pixel"
      ? Math.ceil(crop.x + crop.width)
      : Math.ceil(((crop.x + crop.width) / maxX) * viewport.width);
  const bottom =
    unit === "pixel"
      ? Math.ceil(crop.y + crop.height)
      : Math.ceil(((crop.y + crop.height) / maxY) * viewport.height);

  const boundedX = clampCoordinate(x, 0, viewport.width - 1);
  const boundedY = clampCoordinate(y, 0, viewport.height - 1);
  const width = Math.max(
    1,
    Math.min(viewport.width - boundedX, right - boundedX),
  );
  const height = Math.max(
    1,
    Math.min(viewport.height - boundedY, bottom - boundedY),
  );
  return { x: boundedX, y: boundedY, width, height };
}
