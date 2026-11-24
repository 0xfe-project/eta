/** Muted fills the initial sits on. */
// design-value: a plugin's identity colour, like a logo: hashed from its name and the same in both themes, not a UI colour of the palette
const AVATAR_FILLS = [
  "#5B6EAE",
  "#3F8F8B",
  "#9A5B8F",
  "#B0663F",
  "#5E8C4A",
  "#8A6FB0",
  "#B05A6A",
  "#4F7FA3",
];

/** The letter an avatar shows: the first character of the name, upper case; "?" for an empty name. */
export const avatarInitial = (name: string): string => {
  const first = [...name.trim()][0];
  return first === undefined ? "?" : first.toUpperCase();
};

/** One fill per first letter: "firecrawl" and "figma" share it, whatever the case. */
export const avatarFill = (name: string): string => {
  let h = 0;
  for (const ch of avatarInitial(name)) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return AVATAR_FILLS[h % AVATAR_FILLS.length]!;
};

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

/** The text colour with the better contrast on a fill. */
// design-value: black or white on an identity fill above, whichever reads; the same in both themes
export const avatarInk = (fill: string): string =>
  luminance(fill) > 0.179 ? "#000000" : "#FFFFFF";
