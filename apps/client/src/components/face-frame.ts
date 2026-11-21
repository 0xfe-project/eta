import { _marks } from "blobatar/internal";

/**
 * Room left around a face, in blobatar's viewBox units: enough for antialiasing, and for the
 * animated face's breathe (2.2%) and bob (1.1 units) to stay inside the same frame.
 */
const MARGIN = 2.5;

/** Points sampled along each curve segment when measuring a face. */
const STEPS = 16;

const frames = new Map<string, Frame>();

/** A square window onto blobatar's 100×100 box, in its units. */
export interface Frame {
  x: number;
  y: number;
  size: number;
}

/** Where the face's marks actually reach: circles by their radius, paths along their curves. */
function bounds(seed: string) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const reach = (x: number, y: number) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  for (const mark of _marks(seed).marks) {
    if (mark.kind === "circle") {
      reach(mark.cx - mark.r, mark.cy - mark.r);
      reach(mark.cx + mark.r, mark.cy + mark.r);
      continue;
    }
    // blobatar writes absolute M, L, H, V, C, Q and Z, and nothing else.
    const tokens = mark.d.match(/[A-Z]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
    let at = 0;
    let x = 0;
    let y = 0;
    let command = "";
    const next = () => Number(tokens[at++]);
    while (at < tokens.length) {
      if (/[A-Z]/i.test(tokens[at]!)) command = tokens[at++]!.toUpperCase();
      if (command === "Z") {
        // A closed path is followed by a command or by nothing.
        if (at < tokens.length && !/[A-Z]/i.test(tokens[at]!)) break;
        continue;
      }
      if (command === "M" || command === "L") [x, y] = [next(), next()];
      else if (command === "H") x = next();
      else if (command === "V") y = next();
      else if (command === "C" || command === "Q") {
        const points = command === "C" ? 3 : 2;
        const p = [x, y];
        for (let k = 0; k < points * 2; k++) p.push(next());
        for (let step = 1; step <= STEPS; step++) {
          const t = step / STEPS;
          const u = 1 - t;
          const w =
            points === 3
              ? [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]
              : [u * u, 2 * u * t, t * t];
          reach(
            w.reduce((sum, wk, k) => sum + wk * p[2 * k]!, 0),
            w.reduce((sum, wk, k) => sum + wk * p[2 * k + 1]!, 0),
          );
        }
        [x, y] = [p[points * 2]!, p[points * 2 + 1]!];
        continue;
      } else break;
      reach(x, y);
    }
  }
  return { x0, y0, x1, y1 };
}

/**
 * The square that shows this face whole and as large as it fits: around everything it draws, with
 * a small margin, centred on it.
 *
 * blobatar keeps a face anywhere inside its 100×100 box (a sun or a cloud reaches 5 units from the
 * edge, a small pebble stays near the middle), so one fixed crop either clips the large faces or
 * shrinks the small ones. The old fixed `16 16 68 68` clipped six faces in ten.
 */
export function faceFrame(seed: string): Frame {
  const known = frames.get(seed);
  if (known) return known;
  const { x0, y0, x1, y1 } = bounds(seed);
  const size = Math.max(x1 - x0, y1 - y0) + MARGIN * 2;
  const frame = {
    x: Math.round(((x0 + x1) / 2 - size / 2) * 100) / 100,
    y: Math.round(((y0 + y1) / 2 - size / 2) * 100) / 100,
    size: Math.round(size * 100) / 100,
  };
  // Faces seen in one session are few; an agent list is tens, a draw adds four.
  if (frames.size > 500) frames.clear();
  frames.set(seed, frame);
  return frame;
}
