import type { IdleFrame } from "blobatar/idle";
import type { CanvasRenderingContext2D } from "nsh";
import { idleAt, idleSeeds, idleTransforms } from "blobatar/idle";
import { _posed, lerpPose } from "blobatar/internal";
import {
  Canvas,
  cleanup,
  computed,
  effect,
  Path2D,
  reduceMotion,
  signal,
} from "nsh";
import { Host } from "../services/host";
import { faceFrame } from "./face-frame";
import { motion } from "./motion";

/** `translate(…)`, `rotate(…)`, `scale(…)`: the only steps `blobatar/idle` writes. */
const STEP = /(translate|rotate|scale)\(([^)]*)\)/g;

/**
 * Applies an SVG transform list to the context, step by step and in order, the way SVG composes
 * it. `idleTransforms` hands one of these per level of the animated tree, already ordered as CSS
 * resolves the individual transform properties, so replaying it is the whole port and nothing is
 * re-derived here.
 */
function apply(cx: CanvasRenderingContext2D, list: string) {
  for (const [, op, args] of list.matchAll(STEP)) {
    const [a = 0, b] = args!
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (op === "translate") cx.translate(a, b ?? 0);
    else if (op === "rotate") cx.rotate((a * Math.PI) / 180);
    else cx.scale(a, b ?? a);
  }
}

/**
 * The agent's face, alive: it breathes, bobs, blinks and now and then glances aside, as blobatar's
 * own animated avatars do (`blobatar/motion.css` on the web, `@blobatar/react-native/animated` on
 * phones). Drawn on a `Canvas` from the same figure `AgentFace` shows as an image — the same
 * seed, the same marks, the same frame (`faceFrame`) — so at rest the two are the same picture, and swapping one
 * for the other moves nothing.
 *
 * The idle layer is `blobatar/idle`: a pure function of time whose timings come from the seed, so
 * two faces side by side breathe and blink out of step, and every frame is the library's own
 * numbers replayed level by level (root, breathe, bob, the eye pair, each eye, each eye's path).
 *
 * `animate` turns the motion on and off, ramping over 400ms rather than cutting, and lands on the
 * still face. With reduced motion asked for there is no motion and no frame loop at all. Not used
 * on any screen yet: which faces should move is still to be decided.
 * @public
 */
export function AnimatedAgentFace(props: {
  id?: string | null;
  seed?: string;
  size?: number;
  /** On by default; false holds the still face. */
  animate?: boolean;
}) {
  const host = Host();
  const size = () => props.size ?? 20;
  const seed = () =>
    props.seed ?? host?.agent(props.id)?.avatarSeed ?? props.id ?? "agent";

  // The figure before any pose, which is what the idle layer is composed onto, and its timings.
  const figure = computed(() => {
    const f = _posed(seed());
    return {
      head: f.marks,
      eyes: f.eyes.map((eye) => ({ ...eye, path: new Path2D(eye.d) })),
      paths: f.marks.map((mark) =>
        mark.kind === "path" ? new Path2D(mark.d) : null,
      ),
      frames: { eyes: f.eyeFrames },
      seeds: idleSeeds(seed()),
      // Its frame leaves room for the breathe and the bob, so the moving face is not clipped either.
      view: faceFrame(seed()),
    };
  });
  const idle = lerpPose(undefined, undefined, 1);

  // The clock and the amplitude. `level` is where the ramp was when `target` last changed.
  const now = signal(0);
  const on = () => (props.animate ?? true) && !reduceMotion();
  let from = { at: 0, level: 0, target: 0 };
  const amplitude = (t: number) => {
    const done = Math.min(1, (t - from.at) / motion.faceRamp);
    return from.level + (from.target - from.level) * done;
  };

  effect(() => {
    const target = on() ? 1 : 0;
    if (target === from.target) return;
    const t = performance.now();
    from = { at: t, level: amplitude(t), target };
    let frame: number | undefined;
    // The frame's own time is not used: its origin is the platform's, and the ramp is on this one.
    const tick = () => {
      const time = performance.now();
      now.set(time);
      // Off and settled: the face is still, and nothing is scheduled.
      if (from.target === 0 && amplitude(time) <= 0) return;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    cleanup(() => cancelAnimationFrame(frame));
  });

  return (
    <Canvas
      accessibilityElementsHidden
      style={{ width: size(), height: size(), flexShrink: 0 }}
      draw={(cx, box) => {
        const { head, eyes, paths, frames, seeds, view } = figure();
        const t = now();
        const f: IdleFrame = idleAt(seeds, t, Math.max(0, amplitude(t)));
        const level = idleTransforms(frames, idle, f);
        const k = box.width / view.size;
        cx.save();
        cx.scale(k, k);
        cx.translate(-view.x, -view.y);
        apply(cx, level.root);
        apply(cx, level.breathe);
        apply(cx, level.bob);
        head.forEach((mark, at) => {
          cx.fillStyle = mark.fill;
          if (mark.kind === "path") cx.fill(paths[at]!);
          else {
            cx.beginPath();
            cx.arc(mark.cx, mark.cy, mark.r, 0, Math.PI * 2);
            cx.fill();
          }
        });
        apply(cx, level.eyes);
        eyes.forEach((eye, at) => {
          cx.save();
          apply(cx, level.eye[at]!);
          apply(cx, level.glance[at]!);
          cx.fillStyle = eye.fill;
          cx.fill(eye.path);
          cx.restore();
        });
        cx.restore();
      }}
    />
  );
}
