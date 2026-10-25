import type { Pointer } from "bun:ffi";
import { Buffer } from "node:buffer";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { CString, dlopen, FFIType, ptr } from "bun:ffi";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StructuralNode {
  role: string;
  label: string;
  bbox: Rect;
  focused?: boolean | undefined;
  enabled?: boolean | undefined;
  region?: string | undefined;
  zLayer?: number | undefined;
}

export interface PlannedActionHint {
  actionType: "click" | "type" | "scroll" | "hover" | "navigate";
  targetAnchorId?: number | undefined;
  targetLabelHint?: string | undefined;
  textArg?: string | undefined;
}

export interface ComputerStepInput {
  prevRgb?: Uint8Array | undefined;
  currRgb: Uint8Array;
  width: number;
  height: number;
  subgoal: string;
  cursor?: "arrow" | "ibeam" | "pointer" | "wait" | "progress" | undefined;
  stagnationSteps?: number | undefined;
  nowMs?: number | undefined;
  maxAnchors?: number | undefined;
  resetDelta?: boolean | undefined;
  nextHint?: PlannedActionHint | undefined;
  structuralNodes?: readonly StructuralNode[] | undefined;
}

export type DecisionGate =
  | "fast_commit"
  | "local_micro_correction"
  | "wait_settle"
  | "safety_intercept"
  | "slow_escalation";

export interface FusedAnchorView {
  id: number;
  role: string;
  label: string;
  region: string;
  bbox: Rect;
  focused: boolean;
  confidence: number;
  movedDelta: [number, number];
}

export interface CollapsedRegionView {
  region: string;
  itemCount: number;
  sampleLabels: string;
}

export interface ComputerStepOutcome {
  ok: boolean;
  error?: string | undefined;
  ortVersion: string;
  gate: DecisionGate;
  chosenAction: string;
  chosenAnchorId: number | null;
  chosenBbox: Rect | null;
  chosenProbability: number;
  confidenceMargin: number;
  noul: {
    postconditionMet: number;
    unexpectedBlocker: number;
    irreversibleRisk: number;
  };
  goalProgressScore: number;
  surprise: {
    totalEnergy: number;
    structuralError: number;
    roiEscapeError: number;
    latentResidual: number;
    dirtyRoiIou: number;
    latentCosineSim: number;
  };
  forwardPrediction: {
    regime: "local_perturbation" | "structural_regime_shift";
    expectedFocusId: number | null;
    expectedCursor: string;
    predictedRoi: Rect;
    expectsDropdownOrPopup: boolean;
  };
  dirty: {
    rectCount: number;
    dirtyAreaRatio: number;
    actionOnsetDetected: boolean;
    activeSpinnerDetected: boolean;
    visualSettled: boolean;
  };
  fusion: {
    activeAnchorCount: number;
    collapsedRegionCount: number;
    rigidScrollDetected: boolean;
    rigidScrollDelta: [number, number];
    modalIsolated: boolean;
    retainedIdCount: number;
    newlyAddedCount: number;
    visualLandmarkCount: number;
    landmarkReused: boolean;
  };
  activeAnchors: FusedAnchorView[];
  collapsedRegions: CollapsedRegionView[];
  timingsMs: {
    dirtyDiff: number;
    atlasPack: number;
    detectorOrt: number;
    nmsAndEmbed: number;
    ocrOrt: number;
    fusion: number;
    jevOrt: number;
    forwardPred: number;
    totalStep: number;
  };
  ocrCache: {
    hits: number;
    misses: number;
    totalEntries: number;
  };
}

/** Path to the built native Rust library (`libeta_computer.so` / `.dylib` / `.dll`). */
export function libraryPath(): string {
  const configured = process.env.ETA_COMPUTER_LIB;
  if (configured !== undefined && configured !== "") return configured;
  const ext =
    process.platform === "darwin"
      ? "dylib"
      : process.platform === "win32"
        ? "dll"
        : "so";
  return join(import.meta.dirname, "..", "lib", `libeta_computer.${ext}`);
}

/** Path to the directory holding the 3 exported ONNX models. */
export function modelsDirPath(): string {
  const configured = process.env.ETA_COMPUTER_MODELS_DIR;
  if (configured !== undefined && configured !== "") return configured;
  return join(import.meta.dirname, "..", "models");
}

/** Locate `libonnxruntime` shared library on the host machine. */
export function resolveOrtLibraryPath(): string {
  const configured = process.env.ETA_ORT_LIB;
  if (configured !== undefined && configured !== "") return configured;

  const repoRoot = join(import.meta.dirname, "..", "..", "..");
  const capiDir = join(
    repoRoot,
    "apps",
    "memory",
    ".venv",
    "lib",
    "python3.13",
    "site-packages",
    "onnxruntime",
    "capi",
  );
  if (existsSync(capiDir)) {
    const entry = readdirSync(capiDir).find((f) =>
      f.startsWith("libonnxruntime.so."),
    );
    if (entry !== undefined) return join(capiDir, entry);
  }
  return "libonnxruntime.so";
}

interface NativeSymbols {
  EtaComputerCreate: (ortLibPath: Buffer, modelsDir: Buffer) => Pointer | null;
  EtaComputerMarkClicked: (
    engine: Pointer,
    anchorId: number,
    nowMs: bigint,
  ) => void;
  EtaComputerStep: (
    engine: Pointer,
    prevRgb: Pointer | null,
    currRgb: Pointer,
    rgbLen: bigint,
    width: number,
    height: number,
    spec: Buffer,
  ) => Pointer | null;
  EtaComputerFreeString: (strPtr: Pointer) => void;
  EtaComputerDestroy: (engine: Pointer) => void;
}

let cachedSymbols: NativeSymbols | undefined;

function loadNativeSymbols(): NativeSymbols {
  if (cachedSymbols !== undefined) return cachedSymbols;
  const path = libraryPath();
  if (!existsSync(path)) {
    throw new Error(
      `eta-computer native library not built at ${path}; run 'bun run --cwd packages/eta-computer build'`,
    );
  }
  const lib = dlopen(path, {
    EtaComputerCreate: {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.ptr,
    },
    EtaComputerMarkClicked: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u64],
      returns: FFIType.void,
    },
    EtaComputerStep: {
      args: [
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.u64,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
      ],
      returns: FFIType.ptr,
    },
    EtaComputerFreeString: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
    EtaComputerDestroy: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
  });
  cachedSymbols = lib.symbols as unknown as NativeSymbols;
  return cachedSymbols;
}

const cleanTab = (s: string): string => s.replace(/[\t\r\n]/g, " ");

function serializeStepSpec(input: ComputerStepInput): Buffer {
  const lines: string[] = [];
  lines.push(
    [
      "META",
      cleanTab(input.subgoal),
      cleanTab(input.cursor ?? "arrow"),
      String(input.stagnationSteps ?? 0),
      String(input.nowMs ?? 1000),
      String(input.maxAnchors ?? 32),
      input.resetDelta === true ? "1" : "0",
    ].join("\t"),
  );

  if (input.nextHint !== undefined) {
    lines.push(
      [
        "NEXT",
        cleanTab(input.nextHint.actionType),
        String(input.nextHint.targetAnchorId ?? 0),
        cleanTab(input.nextHint.targetLabelHint ?? ""),
        cleanTab(input.nextHint.textArg ?? ""),
      ].join("\t"),
    );
  }

  if (input.structuralNodes !== undefined) {
    for (const node of input.structuralNodes) {
      lines.push(
        [
          "NODE",
          cleanTab(node.role),
          cleanTab(node.label),
          String(node.bbox.x),
          String(node.bbox.y),
          String(node.bbox.w),
          String(node.bbox.h),
          node.focused === true ? "1" : "0",
          node.enabled === false ? "0" : "1",
          cleanTab(node.region ?? "main"),
          String(node.zLayer ?? 0),
        ].join("\t"),
      );
    }
  }

  return Buffer.from(`${lines.join("\n")}\0`, "utf8");
}

/**
 * The 3-model edge perception, UI-JEPA forward prediction, and OpenJev System-1
 * calibrated decision engine running in native Rust via `bun:ffi`.
 */
export class ComputerTriadEngine {
  private handle: Pointer | null;
  private readonly symbols: NativeSymbols;

  constructor(options?: { ortLibPath?: string; modelsDir?: string }) {
    this.symbols = loadNativeSymbols();
    const ortPath = Buffer.from(
      `${options?.ortLibPath ?? resolveOrtLibraryPath()}\0`,
      "utf8",
    );
    const modelsDir = Buffer.from(
      `${options?.modelsDir ?? modelsDirPath()}\0`,
      "utf8",
    );
    this.handle = this.symbols.EtaComputerCreate(ortPath, modelsDir);
    if (this.handle === null) {
      throw new Error("Failed to initialize EtaComputer native triad engine");
    }
  }

  step(input: ComputerStepInput): ComputerStepOutcome {
    if (this.handle === null) {
      throw new Error("ComputerTriadEngine is already closed");
    }
    const specBuf = serializeStepSpec(input);
    const prevPtr =
      input.prevRgb !== undefined &&
      input.prevRgb.byteLength === input.currRgb.byteLength
        ? ptr(input.prevRgb)
        : null;
    const currPtr = ptr(input.currRgb);

    const outPtr = this.symbols.EtaComputerStep(
      this.handle,
      prevPtr,
      currPtr,
      BigInt(input.currRgb.byteLength),
      input.width,
      input.height,
      specBuf,
    );
    if (outPtr === null) {
      throw new Error("EtaComputerStep returned null pointer");
    }
    try {
      const jsonText = new CString(outPtr).toString();
      const parsed = JSON.parse(jsonText) as ComputerStepOutcome;
      if (!parsed.ok) {
        throw new Error(parsed.error ?? "EtaComputerStep failed");
      }
      return parsed;
    } finally {
      this.symbols.EtaComputerFreeString(outPtr);
    }
  }

  markClicked(anchorId: number, nowMs: number): void {
    if (this.handle === null) return;
    this.symbols.EtaComputerMarkClicked(this.handle, anchorId, BigInt(nowMs));
  }

  close(): void {
    if (this.handle !== null) {
      this.symbols.EtaComputerDestroy(this.handle);
      this.handle = null;
    }
  }
}

/**
 * Helper to synthesize realistic RGB UI frames with rendered buttons, inputs, borders,
 * and modals for deterministic benchmarking and tests.
 */
export function renderSyntheticUiFrame(
  width: number,
  height: number,
  widgets: readonly {
    bbox: Rect;
    kind: "button" | "input" | "danger" | "modal" | "toggle_on";
    focused?: boolean;
  }[],
  dimBackground = false,
): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  const bgLevel = dimBackground ? 12 : 24;
  rgb.fill(bgLevel);

  for (const w of widgets) {
    const x0 = Math.max(0, Math.floor(w.bbox.x));
    const y0 = Math.max(0, Math.floor(w.bbox.y));
    const x1 = Math.min(width, Math.floor(w.bbox.x + w.bbox.w));
    const y1 = Math.min(height, Math.floor(w.bbox.y + w.bbox.h));

    let fillR = 45;
    let fillG = 95;
    let fillB = 210;
    let borderR = 110;
    let borderG = 165;
    let borderB = 255;

    if (w.kind === "input") {
      fillR = 38;
      fillG = 42;
      fillB = 52;
      borderR = w.focused === true ? 80 : 140;
      borderG = w.focused === true ? 180 : 145;
      borderB = w.focused === true ? 255 : 160;
    } else if (w.kind === "danger") {
      fillR = 215;
      fillG = 48;
      fillB = 55;
      borderR = 255;
      borderG = 120;
      borderB = 120;
    } else if (w.kind === "toggle_on") {
      fillR = 35;
      fillG = 185;
      fillB = 95;
      borderR = 110;
      borderG = 240;
      borderB = 150;
    } else if (w.kind === "modal") {
      fillR = 48;
      fillG = 50;
      fillB = 60;
      borderR = 220;
      borderG = 180;
      borderB = 90;
    }

    for (let y = y0; y < y1; y++) {
      const isBorderY = y - y0 < 2 || y1 - 1 - y < 2;
      for (let x = x0; x < x1; x++) {
        const isBorderX = x - x0 < 2 || x1 - 1 - x < 2;
        const idx = (y * width + x) * 3;
        if (isBorderX || isBorderY) {
          rgb[idx] = borderR;
          rgb[idx + 1] = borderG;
          rgb[idx + 2] = borderB;
        } else if (
          y > y0 + 6 &&
          y < y1 - 6 &&
          x > x0 + 10 &&
          x < x1 - 10 &&
          (x + y) % 5 === 0
        ) {
          // Simulated high-contrast glyph strokes inside widget
          rgb[idx] = 235;
          rgb[idx + 1] = 240;
          rgb[idx + 2] = 245;
        } else {
          rgb[idx] = fillR;
          rgb[idx + 1] = fillG;
          rgb[idx + 2] = fillB;
        }
      }
    }
  }

  return rgb;
}
