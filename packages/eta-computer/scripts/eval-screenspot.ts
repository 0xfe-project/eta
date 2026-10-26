#!/usr/bin/env bun
/**
 * ScreenSpot-v2 grounding evaluation for `@eta/computer`.
 *
 * ScreenSpot-v2 is the standard GUI-grounding benchmark: a screenshot, an instruction, and the
 * ground-truth box of the element the instruction refers to. It is the closest public proxy for
 * the part of this package that decides *where* to act, so it is what we score.
 *
 * Two numbers, deliberately separated, because they fail for different reasons:
 *
 *   recall@0.5   — did the detector even propose the right element? Pure Stage-3 perception.
 *   accuracy@0.5 — did the decision head *pick* it out of the proposals? End-to-end pure vision.
 *
 * Feeding no `structuralNodes` keeps this honest: a real desktop has an accessibility tree, and
 * with one the labels come for free. ScreenSpot has only pixels, which is the harder path.
 *
 * Usage:
 *   bun scripts/eval-screenspot.ts [--split desktop|web|mobile|all] [--limit N] [--out path]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { ComputerTriadEngine } from "../src/index";

const RGB_DIR = process.env.SCREENSPOT_RGB_DIR ?? "/tmp/ss/rgb";
const DATA_DIR = process.env.SCREENSPOT_DATA_DIR ?? "/tmp/ss/data";
const MANIFEST = process.env.SCREENSPOT_MANIFEST ?? "/tmp/ss/manifest.json";

interface Annotation {
  img_filename: string;
  bbox: [number, number, number, number];
  instruction: string;
  data_type: string;
  data_source: string;
}

interface ManifestEntry {
  w: number;
  h: number;
  rgb: string;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const iou = (a: Box, b: Box): number => {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  return inter / (a.w * a.h + b.w * b.h - inter);
};

/** ScreenSpot scores a *point*: the predicted centre must fall inside the ground-truth box. */
const centerInside = (p: Box, gt: Box): boolean => {
  const cx = p.x + p.w / 2;
  const cy = p.y + p.h / 2;
  return cx >= gt.x && cx <= gt.x + gt.w && cy >= gt.y && cy <= gt.y + gt.h;
};

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};
const split = flag("split", "all");
const engineKind = flag("engine", "triad") as "triad" | "wevisone";
const isWeVisOne = engineKind === "wevisone";
const limit = Number(flag("limit", "0"));
const outPath = flag("out", `/tmp/ss/report-${engineKind}.json`);

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<
  string,
  ManifestEntry
>;
const splits = split === "all" ? ["desktop", "web", "mobile"] : [split];

interface Row {
  split: string;
  source: string;
  dataType: string;
  instruction: string;
  gt: Box;
  chosen: Box | null;
  chosenProb: number;
  anchors: number;
  iou: number;
  hit: boolean;
  pointHit: boolean;
  /** Baseline: the highest detector-confidence proposal, ignoring the instruction. */
  confidenceHit: boolean;
  /** Baseline: the proposal whose label overlaps the instruction most, ignoring confidence. */
  labelHit: boolean;
  /** WeVisOne declined to answer (its abstention slot won). */
  rejected?: boolean;
  /** WeVisOne ran the two-stage foveated refinement. */
  foveated?: boolean;
  totalMs: number;
  detectorMs: number;
  jevMs: number;
  error?: string;
}

const rows: Row[] = [];
const engine = new ComputerTriadEngine();

try {
  for (const s of splits) {
    const all = JSON.parse(
      readFileSync(join(DATA_DIR, `screenspot_${s}_v2.json`), "utf8"),
    ) as Annotation[];
    const items = limit > 0 ? all.slice(0, limit) : all;
    process.stderr.write(`[${s}] ${items.length} samples\n`);

    for (const [i, item] of items.entries()) {
      const entry = manifest[item.img_filename];
      if (entry === undefined) continue;
      const [gx, gy, gw, gh] = item.bbox;
      const gt: Box = { x: gx, y: gy, w: gw, h: gh };
      const rgb = new Uint8Array(readFileSync(join(RGB_DIR, entry.rgb)));

      const row: Row = {
        split: s,
        source: item.data_source,
        dataType: item.data_type,
        instruction: item.instruction,
        gt,
        chosen: null,
        chosenProb: 0,
        anchors: 0,
        iou: 0,
        hit: false,
        pointHit: false,
        confidenceHit: false,
        labelHit: false,
        totalMs: 0,
        detectorMs: 0,
        jevMs: 0,
      };

      try {
        if (isWeVisOne) {
          const g = engine.groundWeVisOne({
            currRgb: rgb,
            width: entry.w,
            height: entry.h,
            task: "point",
            query: item.instruction,
          });
          row.totalMs = g.timingsMs.total;
          row.detectorMs = g.timingsMs.visionAndPrefill;
          row.jevMs = g.timingsMs.decode;
          row.anchors = 1;
          row.chosenProb = g.rejected ? 0 : 1;
          row.rejected = g.rejected;
          row.foveated = g.foveatedRefined;
          if (g.point !== null) {
            row.chosen = { x: g.point[0], y: g.point[1], w: 1, h: 1 };
            // A point is the answer itself: either it lands in the GT box or it does not.
            row.pointHit =
              g.point[0] >= gt.x &&
              g.point[0] <= gt.x + gt.w &&
              g.point[1] >= gt.y &&
              g.point[1] <= gt.y + gt.h;
            row.iou = row.pointHit ? 1 : 0;
            row.hit = row.pointHit;
          }
          rows.push(row);
          if ((i + 1) % 25 === 0) {
            const done = rows.filter((r) => r.split === s);
            const acc = done.filter((r) => r.pointHit).length / done.length;
            process.stderr.write(
              `  ${i + 1}/${items.length}  point-acc=${(acc * 100).toFixed(1)}%\n`,
            );
          }
          continue;
        }

        const out = engine.step({
          currRgb: rgb,
          width: entry.w,
          height: entry.h,
          subgoal: item.instruction,
          nowMs: 1000,
          resetDelta: true,
          // No accessibility tree: pixels only, which is the point.
          structuralNodes: [],
        });
        row.anchors = out.fusion.visualLandmarkCount;
        row.totalMs = out.timingsMs.totalStep;
        row.detectorMs = out.timingsMs.detectorOrt;
        row.jevMs = out.timingsMs.jevOrt;
        row.chosen = out.chosenBbox;
        row.chosenProb = out.chosenProbability;

        // recall: is the GT element among the proposals at all?
        const proposals = out.activeAnchors.map((a) => a.bbox);
        for (const p of proposals) {
          const v = iou(p, gt);
          if (v > row.iou) row.iou = v;
        }
        row.hit = row.iou >= 0.5;
        row.pointHit =
          out.chosenBbox !== null && centerInside(out.chosenBbox, gt);

        // Two trivial pickers, to show whether the decision head earns its 151M parameters.
        const anchors = out.activeAnchors;
        const byConfidence = [...anchors].sort(
          (a, b) => b.confidence - a.confidence,
        )[0];
        row.confidenceHit =
          byConfidence !== undefined && centerInside(byConfidence.bbox, gt);
        const words = item.instruction
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((w) => w.length >= 3);
        const overlap = (label: string): number => {
          const l = label.toLowerCase();
          return words.reduce((n, w) => n + (l.includes(w) ? 1 : 0), 0);
        };
        const byLabel = [...anchors].sort(
          (a, b) => overlap(b.label) - overlap(a.label),
        )[0];
        row.labelHit =
          byLabel !== undefined &&
          overlap(byLabel.label) > 0 &&
          centerInside(byLabel.bbox, gt);
      } catch (err) {
        row.error = err instanceof Error ? err.message : String(err);
      }

      rows.push(row);
      if ((i + 1) % 50 === 0) {
        const done = rows.filter((r) => r.split === s);
        const acc = done.filter((r) => r.pointHit).length / done.length;
        process.stderr.write(
          `  ${i + 1}/${items.length}  point-acc=${(acc * 100).toFixed(1)}%\n`,
        );
      }
    }
  }
} finally {
  engine.close();
}

const pct = (n: number, d: number): string =>
  d === 0 ? "   -" : `${((n / d) * 100).toFixed(1).padStart(5)}%`;
const med = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

interface Summary {
  n: number;
  recall: number;
  accuracy: number;
  confidenceBaseline: number;
  labelBaseline: number;
  iou50: number;
  medianTotalMs: number;
  medianDetMs: number;
  medianJevMs: number;
}

const summarize = (subset: Row[]): Summary => ({
  n: subset.length,
  recall: subset.filter((r) => r.hit).length,
  accuracy: subset.filter((r) => r.pointHit).length,
  confidenceBaseline: subset.filter((r) => r.confidenceHit).length,
  labelBaseline: subset.filter((r) => r.labelHit).length,
  iou50: subset.filter((r) => r.iou >= 0.5).length,
  medianTotalMs: med(subset.map((r) => r.totalMs)),
  medianDetMs: med(subset.map((r) => r.detectorMs)),
  medianJevMs: med(subset.map((r) => r.jevMs)),
});

const bySplit: Record<string, Summary> = {};
for (const s of splits)
  bySplit[s] = summarize(rows.filter((r) => r.split === s));
const overall = summarize(rows);

const line = (label: string, s: Summary): string =>
  `${label.padEnd(22)} n=${String(s.n).padStart(4)}  recall@.5=${pct(s.recall, s.n)}  point-acc=${pct(s.accuracy, s.n)}  ` +
  `[conf-only=${pct(s.confidenceBaseline, s.n)} label-only=${pct(s.labelBaseline, s.n)}]  ` +
  `med total=${s.medianTotalMs.toFixed(0).padStart(4)}ms det=${s.medianDetMs.toFixed(0).padStart(4)}ms jev=${s.medianJevMs.toFixed(0).padStart(3)}ms`;

console.log("");
for (const [s, summary] of Object.entries(bySplit))
  console.log(line(s, summary));
console.log(line("ALL", overall));

// Where it fails is more useful than the rate: group misses by instruction wording and by size.
const misses = rows.filter((r) => !r.pointHit && r.error === undefined);
const tiny = misses.filter((r) => r.gt.w * r.gt.h < 32 * 32).length;
console.log(`\nmisses: ${misses.length}  target <32x32: ${tiny}`);
if (isWeVisOne) {
  const rejected = rows.filter((r) => r.rejected === true).length;
  const foveated = rows.filter((r) => r.foveated === true).length;
  console.log(`abstained: ${rejected}  foveated-refined: ${foveated}`);
} else {
  const noProposal = misses.filter((r) => !r.hit).length;
  console.log(`of which no proposal at all: ${noProposal}`);
}
const errors = rows.filter((r) => r.error !== undefined);
if (errors.length > 0)
  console.log(`errors: ${errors.length}, first: ${errors[0]!.error}`);

writeFileSync(outPath, JSON.stringify({ overall, bySplit, rows }, null, 2));
console.log(`\nreport -> ${outPath}`);
