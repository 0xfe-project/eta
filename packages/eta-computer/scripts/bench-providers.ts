/**
 * Measures the three edge models and the full speculative step per execution provider.
 *
 *   bun run bench                       # every provider the runtime can register
 *   bun run bench -- cuda cpu           # only the listed ones
 *
 * CUDA runs need the CUDA 12 runtime and cuDNN 9 on `PATH`; without them the probe rejects `cuda`
 * and the engine falls back, which the printed `provider` column makes obvious.
 */
import type { StructuralNode } from "../src/index";
import process from "node:process";
import { ComputerTriadEngine, renderSyntheticUiFrame } from "../src/index";

const WIDTH = 1280;
const HEIGHT = 720;
const RUNS = 9;

const nodes: StructuralNode[] = [
  {
    role: "searchbox",
    label: "Search packages",
    bbox: { x: 80, y: 60, w: 220, h: 40 },
    region: "header",
  },
  {
    role: "button",
    label: "Run Search",
    bbox: { x: 320, y: 60, w: 120, h: 40 },
    region: "header",
  },
  {
    role: "button",
    label: "Filter Active",
    bbox: { x: 80, y: 140, w: 160, h: 38 },
    region: "main",
  },
];

const idleFrame = renderSyntheticUiFrame(WIDTH, HEIGHT, [
  { bbox: { x: 80, y: 60, w: 220, h: 40 }, kind: "input" },
  { bbox: { x: 320, y: 60, w: 120, h: 40 }, kind: "button" },
  { bbox: { x: 80, y: 140, w: 160, h: 38 }, kind: "button" },
]);
// A dialog-free but substantially different frame, so the dirty-ratio fast path cannot skip the
// detector's convolution stack.
const busyFrame = renderSyntheticUiFrame(WIDTH, HEIGHT, [
  { bbox: { x: 80, y: 60, w: 220, h: 40 }, kind: "input", focused: true },
  { bbox: { x: 320, y: 60, w: 120, h: 40 }, kind: "button" },
  { bbox: { x: 80, y: 140, w: 160, h: 38 }, kind: "button" },
  { bbox: { x: 200, y: 260, w: 640, h: 320 }, kind: "modal" },
]);
// Only the focus ring differs from `idleFrame`, which is the case the detector fast path covers.
const focusedFrame = renderSyntheticUiFrame(WIDTH, HEIGHT, [
  { bbox: { x: 80, y: 60, w: 220, h: 40 }, kind: "input", focused: true },
  { bbox: { x: 320, y: 60, w: 120, h: 40 }, kind: "button" },
  { bbox: { x: 80, y: 140, w: 160, h: 38 }, kind: "button" },
]);

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0
  );
}

interface ProviderReport {
  case: string;
  provider: string;
  ocrProvider: string;
  encoderProvider: string;
  providerChain: string[];
  ortVersion: string;
  loadMs: number;
  firstStep: number;
  firstOcr: number;
  firstOcrAnchors: number;
  detectorOrt: number;
  ocrOrt: number;
  jevOrt: number;
  coldStep: number;
  coldP95: number;
  warmStep: number;
  cachedStep: number;
}

function measure(benchCase: string): ProviderReport {
  const t0 = performance.now();
  // `default` leaves the provider choice to the engine (the shipping configuration); anything else
  // is passed as an explicit preference and therefore applies to all three models.
  const engine =
    benchCase === "default"
      ? new ComputerTriadEngine()
      : new ComputerTriadEngine({ providers: benchCase });
  const loadMs = performance.now() - t0;

  const baseStep = {
    width: WIDTH,
    height: HEIGHT,
    resetDelta: true,
    nextHint: {
      actionType: "click" as const,
      targetLabelHint: "Search packages",
    },
    structuralNodes: nodes,
  };

  let provider = "unknown";
  let ocrProvider = "unknown";
  let encoderProvider = "unknown";
  let providerChain: string[] = [];
  let ortVersion = "unknown";
  const detector: number[] = [];
  const ocr: number[] = [];
  const jev: number[] = [];
  const cold: number[] = [];
  let firstStep = 0;
  let firstOcr = 0;
  let firstOcrAnchors = 0;
  let warm = 0;
  let cached = 0;

  try {
    // First step after load: what an agent loop actually feels once, before any cache is warm. Its
    // OCR pass touches every anchor, so it is reported separately from the steady-state medians.
    const firstOut = engine.step({
      ...baseStep,
      currRgb: busyFrame,
      subgoal: "Click the Search packages input box (first frame)",
      nowMs: 900,
    });
    firstStep = firstOut.timingsMs.totalStep;
    firstOcr = firstOut.timingsMs.ocrOrt;
    firstOcrAnchors = firstOut.ocrCache.misses;

    for (let i = 0; i < RUNS; i += 1) {
      // Rotate the subgoal so the verdict cache always misses: this is the encoder's real cost.
      const subgoal = `Click the Search packages input box (case ${i})`;
      const coldOut = engine.step({
        ...baseStep,
        currRgb: i % 2 === 0 ? busyFrame : idleFrame,
        subgoal,
        nowMs: 1000 + i * 400,
      });
      provider = coldOut.provider;
      ocrProvider = coldOut.ocrProvider;
      encoderProvider = coldOut.encoderProvider;
      providerChain = coldOut.providerChain;
      ortVersion = coldOut.ortVersion;
      detector.push(coldOut.timingsMs.detectorOrt);
      jev.push(coldOut.timingsMs.jevOrt);
      if (coldOut.timingsMs.ocrOrt > 0) ocr.push(coldOut.timingsMs.ocrOrt);
      cold.push(coldOut.timingsMs.totalStep);
    }

    // Warm step: only the input's focus ring changed, so the detector's fast path skips the
    // convolution stack while the verdict still has to be recomputed for the new subgoal.
    const warmOut = engine.step({
      ...baseStep,
      prevRgb: idleFrame,
      currRgb: focusedFrame,
      subgoal: "Type eta-core into Search packages",
      cursor: "ibeam",
      nowMs: 9000,
      resetDelta: false,
      nextHint: {
        actionType: "type",
        targetLabelHint: "Search packages",
        textArg: "eta-core",
      },
    });
    warm = warmOut.timingsMs.totalStep;

    // Repeat decision: identical prompt and unchanged structure.
    const repeatOut = engine.step({
      ...baseStep,
      prevRgb: focusedFrame,
      currRgb: focusedFrame,
      subgoal: "Type eta-core into Search packages",
      cursor: "ibeam",
      nowMs: 9400,
      resetDelta: false,
      nextHint: {
        actionType: "type",
        targetLabelHint: "Search packages",
        textArg: "eta-core",
      },
    });
    cached = repeatOut.timingsMs.totalStep;
  } finally {
    engine.close();
  }

  return {
    case: benchCase,
    provider,
    ocrProvider,
    encoderProvider,
    providerChain,
    ortVersion,
    loadMs,
    firstStep,
    firstOcr,
    firstOcrAnchors,
    detectorOrt: median(detector),
    ocrOrt: ocr.length > 0 ? median(ocr) : 0,
    jevOrt: median(jev),
    coldStep: median(cold),
    coldP95: p95(cold),
    warmStep: warm,
    cachedStep: cached,
  };
}

const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const cases = requested.length > 0 ? requested : ["default", "cuda", "cpu"];

const reports = cases.map((benchCase) => measure(benchCase));

for (const report of reports) {
  console.log(`\n== ${report.case} ==`);
  console.log(
    `  ort ${report.ortVersion}   load ${report.loadMs.toFixed(0)} ms   detectors ${report.provider} / ocr ${report.ocrProvider} / encoder ${report.encoderProvider}`,
  );
  if (report.providerChain.length > 1) {
    console.log(`  chain: ${report.providerChain.join(" | ")}`);
  }
  console.log(
    `  detector ${report.detectorOrt.toFixed(2)} ms   ocr ${report.ocrOrt.toFixed(2)} ms   jev ${report.jevOrt.toFixed(2)} ms`,
  );
  console.log(
    `  first step ${report.firstStep.toFixed(2)} ms (ocr ${report.firstOcr.toFixed(2)} ms over ${report.firstOcrAnchors} anchors)   cold ${report.coldStep.toFixed(2)} ms (p95 ${report.coldP95.toFixed(2)})   warm ${report.warmStep.toFixed(2)} ms   cached ${report.cachedStep.toFixed(2)} ms`,
  );
}

// Pure-vision WeVisOne-VL-2B (onnxruntime-genai) CPU Grounding Benchmark
const pureEngine = new ComputerTriadEngine({ providers: "cpu" });
try {
  const pureFrame = renderSyntheticUiFrame(640, 360, [
    { bbox: { x: 100, y: 120, w: 160, h: 50 }, kind: "button" },
    { bbox: { x: 340, y: 120, w: 160, h: 50 }, kind: "danger" },
  ]);
  const coldGround = pureEngine.groundWeVisOne({
    currRgb: pureFrame,
    width: 640,
    height: 360,
    task: "point",
    query: "the blue button on the left",
    targetWidth: 224,
    targetHeight: 128,
  });
  const warmPoint = pureEngine.groundWeVisOne({
    currRgb: pureFrame,
    width: 640,
    height: 360,
    task: "point",
    query: "the blue button on the left",
    targetWidth: 224,
    targetHeight: 128,
  });
  const warmBox = pureEngine.groundWeVisOne({
    currRgb: pureFrame,
    width: 640,
    height: 360,
    task: "referring",
    query: "the red button on the right",
    targetWidth: 224,
    targetHeight: 128,
  });
  const warmReject = pureEngine.groundWeVisOne({
    currRgb: pureFrame,
    width: 640,
    height: 360,
    task: "referring",
    query: "a yellow star icon in the bottom right corner",
    targetWidth: 224,
    targetHeight: 128,
  });
  const frame4K = renderSyntheticUiFrame(3840, 2160, [
    { bbox: { x: 2800, y: 1500, w: 180, h: 56 }, kind: "danger" },
  ]);
  const fov4K = pureEngine.groundWeVisOne({
    currRgb: frame4K,
    width: 3840,
    height: 2160,
    task: "referring",
    query: "the red button",
    foveatedRefine: true,
  });
  console.log(
    "\n== wevisone-vl-2b-oga (CPU pure-vision grounding, aspect-ratio smart-resize + 4K foveated zoom) ==",
  );
  console.log(
    `  cold (ViT + visual prefill + decode): ${coldGround.timingsMs.total.toFixed(1)} ms (vis+prefill ${coldGround.timingsMs.visionAndPrefill.toFixed(1)} ms, query ${coldGround.timingsMs.queryPrefill.toFixed(1)} ms, decode ${coldGround.timingsMs.decode.toFixed(1)} ms) -> point=${JSON.stringify(coldGround.point)}`,
  );
  console.log(
    `  warm point (OgaGenerator_RewindTo KV-cache): ${warmPoint.timingsMs.total.toFixed(1)} ms (query ${warmPoint.timingsMs.queryPrefill.toFixed(1)} ms, decode ${warmPoint.timingsMs.decode.toFixed(1)} ms) -> point=${JSON.stringify(warmPoint.point)}`,
  );
  console.log(
    `  warm box (OgaGenerator_RewindTo KV-cache):   ${warmBox.timingsMs.total.toFixed(1)} ms (query ${warmBox.timingsMs.queryPrefill.toFixed(1)} ms, decode ${warmBox.timingsMs.decode.toFixed(1)} ms) -> bbox=${JSON.stringify(warmBox.bbox)}`,
  );
  console.log(
    `  warm reject (absent target -> <box>none):    ${warmReject.timingsMs.total.toFixed(1)} ms (query ${warmReject.timingsMs.queryPrefill.toFixed(1)} ms, decode ${warmReject.timingsMs.decode.toFixed(1)} ms) -> rejected=${warmReject.rejected}`,
  );
  console.log(
    `  4K (3840x2160) 2-stage coarse-to-fine zoom:  ${fov4K.timingsMs.total.toFixed(1)} ms (stage1 ${fov4K.timingsMs.visionAndPrefill.toFixed(1)} ms, stage2 refine ${fov4K.timingsMs.refine.toFixed(1)} ms, ${fov4K.visualTokens} vis tokens) -> coarse=${JSON.stringify(fov4K.coarsePoint)} refined=${JSON.stringify(fov4K.point)}`,
  );
} finally {
  pureEngine.close();
}

process.exit(0);
