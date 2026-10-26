import type { Pointer } from "bun:ffi";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
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
  /**
   * When true, automatically invokes the local quantized `WeVisOne-VL-2B` (`onnxruntime-genai`)
   * pure-vision grounding engine whenever System-1 returns `slow_escalation` (e.g. when A11y
   * nodes are absent or an icon/Chinese label is unrecognized), injecting the grounded target
   * into `PersistentAnchorTracker` so subsequent frames track it at ~15ms.
   */
  enableWeVisOneFallback?: boolean | undefined;
  nextHint?: PlannedActionHint | undefined;
  structuralNodes?: readonly StructuralNode[] | undefined;
}

export interface WeVisOneGroundInput {
  currRgb: Uint8Array;
  width: number;
  height: number;
  task?: "point" | "referring" | "ocr_grounding" | undefined;
  query: string;
  /**
   * Optional explicit resize width. When omitted or `0`, `smart_resize_qwen3_vl` computes
   * aspect-ratio-preserving multiples of 32 bounded by `maxVisualTokens` (default 512).
   */
  targetWidth?: number | undefined;
  /**
   * Optional explicit resize height. When omitted or `0`, `smart_resize_qwen3_vl` computes
   * aspect-ratio-preserving multiples of 32 bounded by `maxVisualTokens` (default 32).
   */
  targetHeight?: number | undefined;
  roi?: Rect | undefined;
  /** Maximum visual token budget for dynamic aspect-ratio-preserving smart resize (default 32). */
  maxVisualTokens?: number | undefined;
  /**
   * When true (or omitted on high-res frames `>= 1600px`), runs a 2-stage coarse-to-fine
   * foveated zoom: Stage 1 locates the coarse region globally, then Stage 2 crops a 1:1
   * native-resolution window around the coarse point so tiny 4K icons/text are never lost.
   */
  foveatedRefine?: boolean | undefined;
}

export interface WeVisOneGroundingOutcome {
  task: string;
  query: string;
  rejected: boolean;
  point: [number, number] | null;
  bbox: Rect | null;
  normCoords: number[];
  rawResponse: string;
  visualTokens: number;
  kvCacheReused: boolean;
  foveatedRefined: boolean;
  coarsePoint: [number, number] | null;
  refinedRoi: Rect | null;
  timingsMs: {
    preprocess: number;
    visionAndPrefill: number;
    queryPrefill: number;
    decode: number;
    refine: number;
    total: number;
  };
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
  /** Execution provider the sessions actually run on: `cuda`, `directml`, `coreml` or `cpu`. */
  provider: "cuda" | "directml" | "coreml" | "cpu";
  /** Execution provider for the OCR head (it probes the same chain as the detector). */
  ocrProvider: "cuda" | "directml" | "coreml" | "cpu";
  /**
   * Execution provider for the calibrated verdict encoder. Stays on `cpu` even on a GPU machine
   * unless `ETA_COMPUTER_ENCODER_PROVIDER` overrides it — a 48-token INT8 forward is faster there.
   */
  encoderProvider: "cuda" | "directml" | "coreml" | "cpu";
  /** Preference chain that was attempted, with the probe failure inlined for rejected providers. */
  providerChain: string[];
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
  wevisoneGrounding: WeVisOneGroundingOutcome | null;
  timingsMs: {
    dirtyDiff: number;
    atlasPack: number;
    detectorOrt: number;
    nmsAndEmbed: number;
    ocrOrt: number;
    fusion: number;
    jevOrt: number;
    wevisoneOga: number;
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

/**
 * ONNX Runtime is shipped beside the cdylib (see `scripts/build.ts`). Windows searches a DLL's
 * imports in the executable's directory and `PATH` — never the importing DLL's own directory — so
 * the runtime is loaded by absolute path first, and its directory is pushed onto `PATH` for the
 * provider DLLs (and the CUDA/cuDNN libraries they pull in) that ONNX Runtime loads later.
 */
let runtimeLoaded = false;
// Retained for the process lifetime: the cdylib's import table resolves against this module.
const preloadedLibraries: unknown[] = [];

function ensureOrtRuntime(libPath: string): void {
  if (runtimeLoaded) return;
  runtimeLoaded = true;
  const libDir = dirname(libPath);
  const pathKey = Object.keys(process.env).find(
    (key) => key.toUpperCase() === "PATH",
  );
  if (pathKey !== undefined) {
    process.env[pathKey] = `${libDir}${delimiter}${process.env[pathKey] ?? ""}`;
  }
  if (process.platform !== "win32") return;
  const runtime = join(libDir, "onnxruntime.dll");
  if (existsSync(runtime)) {
    preloadedLibraries.push(
      dlopen(runtime, { OrtGetApiBase: { args: [], returns: FFIType.ptr } }),
    );
  }
  const genaiRuntime = join(libDir, "onnxruntime-genai.dll");
  if (existsSync(genaiRuntime)) {
    preloadedLibraries.push(
      dlopen(genaiRuntime, {
        OgaShutdown: { args: [], returns: FFIType.void },
      }),
    );
  }
}

interface NativeSymbols {
  EtaComputerCreate: (
    modelsDir: Buffer,
    providerSpec: Buffer,
  ) => Pointer | null;
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
  EtaComputerGroundWeVisOne: (
    engine: Pointer,
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
  ensureOrtRuntime(path);
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
    EtaComputerGroundWeVisOne: {
      args: [
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
      input.enableWeVisOneFallback === true ? "1" : "0",
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

  /**
   * `providers` is an explicit execution-provider preference for **all three** models, e.g.
   * `"cuda,directml,cpu"`. Leaving it out keeps the defaults: `ETA_COMPUTER_PROVIDER` for the
   * perception chain (detector + OCR), and `ETA_COMPUTER_ENCODER_PROVIDER` for the verdict encoder,
   * which stays on the CPU on GPU machines because it is measurably faster there. Providers the
   * shipped ONNX Runtime cannot register are skipped and reported in
   * {@link ComputerStepOutcome.providerChain}.
   */
  constructor(options?: { providers?: string; modelsDir?: string }) {
    this.symbols = loadNativeSymbols();
    const providerSpec = Buffer.from(`${options?.providers ?? ""}\0`, "utf8");
    const modelsDir = Buffer.from(
      `${options?.modelsDir ?? modelsDirPath()}\0`,
      "utf8",
    );
    this.handle = this.symbols.EtaComputerCreate(modelsDir, providerSpec);
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

  /**
   * Run pure-vision grounding via the slimmed/quantized `WeVisOne-VL-2B` (`onnxruntime-genai`).
   * Reuses the visual KV cache (`OgaGenerator_RewindTo`) when called repeatedly on the same frame.
   */
  groundWeVisOne(input: WeVisOneGroundInput): WeVisOneGroundingOutcome {
    if (this.handle === null) {
      throw new Error("ComputerTriadEngine is already closed");
    }
    const autoFoveated =
      input.foveatedRefine ??
      (input.roi === undefined && (input.width >= 1600 || input.height >= 900));
    const specLine = [
      cleanTab(input.task ?? "referring"),
      cleanTab(input.query),
      String(input.targetWidth ?? 0),
      String(input.targetHeight ?? 0),
      String(input.roi?.x ?? 0),
      String(input.roi?.y ?? 0),
      String(input.roi?.w ?? 0),
      String(input.roi?.h ?? 0),
      // 0 = "use the native default". Sending a literal here would silently override it,
      // which is how the budget stayed at 32 long after the native side stopped defaulting to it.
      String(input.maxVisualTokens ?? 0),
      autoFoveated ? "1" : "0",
    ].join("\t");
    const specBuf = Buffer.from(`${specLine}\0`, "utf8");
    const outPtr = this.symbols.EtaComputerGroundWeVisOne(
      this.handle,
      ptr(input.currRgb),
      BigInt(input.currRgb.byteLength),
      input.width,
      input.height,
      specBuf,
    );
    if (outPtr === null) {
      throw new Error("EtaComputerGroundWeVisOne returned null pointer");
    }
    try {
      const jsonText = new CString(outPtr).toString();
      const parsed = JSON.parse(jsonText) as {
        ok: boolean;
        error?: string;
        grounding?: WeVisOneGroundingOutcome;
      };
      if (!parsed.ok || parsed.grounding === undefined) {
        throw new Error(parsed.error ?? "EtaComputerGroundWeVisOne failed");
      }
      return parsed.grounding;
    } finally {
      this.symbols.EtaComputerFreeString(outPtr);
    }
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
