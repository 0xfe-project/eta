import type { Theme } from "../config/types";

/**
 * The eta mark in block characters: a tall stem, an arch that reads as `h` or `η`, a foot to the
 * right, and a square of its own at the top right, as in `public/Eta-Banner.png`.
 */
export const LOGO_LINES: readonly string[] = [
  "█████          █████",
  "█████          ▀▀▀▀▀",
  "███████████████     ",
  "███████████████     ",
  "█████     █████     ",
  "█████     █████     ",
  "█████     ██████████",
  "█████     ██████████",
];

const HEX6 = /^#[0-9a-f]{6}$/i;

function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function interpolate(from: string, to: string, t: number): string {
  const a = channels(from);
  const b = channels(to);
  return toHex(
    [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as [
      number,
      number,
      number,
    ],
  );
}

/**
 * One colour per logo line, from `brand` at the top to `brandDim` at the bottom. Both `#rrggbb`:
 * interpolated line by line. Otherwise the upper half is `brand` and the lower half `brandDim`.
 * `default` gives undefined: the terminal's own colour.
 */
export function logoLineColors(
  theme: Pick<Theme, "brand" | "brandDim">,
  lineCount: number = LOGO_LINES.length,
): (string | undefined)[] {
  const plain = (value: string) => (value === "default" ? undefined : value);
  if (HEX6.test(theme.brand) && HEX6.test(theme.brandDim)) {
    return Array.from({ length: lineCount }, (_, i) =>
      interpolate(
        theme.brand,
        theme.brandDim,
        lineCount === 1 ? 0 : i / (lineCount - 1),
      ),
    );
  }
  const upper = Math.ceil(lineCount / 2);
  return Array.from({ length: lineCount }, (_, i) =>
    plain(i < upper ? theme.brand : theme.brandDim),
  );
}
