import type { TaskStatus } from "@/queries/tasks";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "@rstest/core";
import { statusTone } from "./task-format";

// A status label's words are 12px text on a tint of their own colour. Read from the tokens in
// styles.css and the tints in task-format, they keep WCAG AA (4.5:1) in both themes, over the page
// and over the muted grey a board column or a hovered row sits on.

const styles = readFileSync(
  new URL("../../styles.css", import.meta.url),
  "utf8",
);

/** The `--name: value;` lines of the first block that opens with `selector {`. */
function block(selector: string): Map<string, string> {
  const start = styles.indexOf(`\n${selector} {`);
  const body = styles.slice(start, styles.indexOf("\n}", start));
  return new Map(
    [...body.matchAll(/--([\w-]+): ?([^;]+);/g)].map((m) => [
      m[1]!,
      m[2]!.trim(),
    ]),
  );
}

type Oklch = [number, number, number];

function resolve(tokens: Map<string, string>, name: string): Oklch {
  const value = tokens.get(name);
  if (value === undefined) throw new Error(`no --${name}`);
  const literal = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(value);
  if (literal)
    return [Number(literal[1]), Number(literal[2]), Number(literal[3])];
  const alias = /^var\(--([\w-]+)\)$/.exec(value);
  if (alias) return resolve(tokens, alias[1]!);
  const mix =
    /^color-mix\(in oklch, var\(--([\w-]+)\) ([\d.]+)%, var\(--([\w-]+)\)\)$/.exec(
      value,
    );
  if (mix) {
    const a = resolve(tokens, mix[1]!);
    const b = resolve(tokens, mix[3]!);
    const p = Number(mix[2]) / 100;
    // An achromatic end has no hue: the mix takes the other one's.
    const hue = a[1] === 0 ? b[2] : a[2];
    return [a[0] * p + b[0] * (1 - p), a[1] * p + b[1] * (1 - p), hue];
  }
  throw new Error(`--${name}: ${value} is not a colour this test reads`);
}

/** oklch to linear sRGB, clipped to the gamut. */
function linear([L, C, h]: Oklch): number[] {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => Math.min(1, Math.max(0, v)));
}
const encode = (v: number) =>
  v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
const decode = (v: number) =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
/** `top` at `alpha` over `under`, blended in sRGB as a browser paints it. */
const over = (top: number[], alpha: number, under: number[]) =>
  top.map((v, i) =>
    decode(encode(v) * alpha + encode(under[i]!) * (1 - alpha)),
  );
const luminance = ([r, g, b]: number[]) =>
  0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
function contrast(a: number[], b: number[]) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** The class's token and alpha: `text-state-info-ink` → state-info-ink, `bg-x/10` → x at 0.1. */
const token = (cls: string) => /^(?:text|bg)-([\w-]+)(?:\/(\d+))?$/.exec(cls)!;

const statuses: TaskStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
];

describe("a status label's contrast", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`keeps 4.5:1 for its words on its tint, ${theme}`, () => {
      const tokens =
        theme === "light"
          ? block(":root")
          : new Map([...block(":root"), ...block(".dark")]);
      const ratios: Record<string, number> = {};
      for (const status of statuses) {
        const tone = statusTone(status);
        const [, ink] = token(tone.ink);
        const tint = tone.tint
          .split(" ")
          .find((cls) => (theme === "dark") === cls.startsWith("dark:"))!
          .replace("dark:", "");
        const [, tinted, percent] = token(tint);
        for (const page of ["background", "muted"]) {
          const ground = over(
            linear(resolve(tokens, tinted!)),
            Number(percent) / 100,
            linear(resolve(tokens, page)),
          );
          ratios[`${status} on ${page}`] = contrast(
            linear(resolve(tokens, ink!)),
            ground,
          );
        }
      }
      const low = Object.entries(ratios).filter(([, ratio]) => ratio < 4.5);
      expect(low).toEqual([]);
    });
  }
});
