export const imageLimit = 4 * 1024 * 1024;
export const settingsKey = "etaTheme";
export const sitesKey = "etaThemeSites";

export const palettes = {
  light: {
    canvas: "#ffffff",
    surface: "#fafafa",
    selected: "#f2f2f2",
    ink: "#111111",
    muted: "#6e6e6e",
    mutedInk: "#505050",
    faint: "#8c8c8c",
    border: "#e5e5e5",
    strong: "#cccccc",
    button: "#171717",
    buttonInk: "#ffffff",
    blue: "#006cb5",
    ring: "#737373",
    blueFill: "#e0eff8",
    green: "#008035",
    greenFill: "#e8f2eb",
    amber: "#a46700",
    amberFill: "#f7efdf",
    warning: "#c37000",
    warningInk: "#955a00",
    red: "#c61623",
    redFill: "#fce9eb",
  },
  dark: {
    canvas: "#0a0a0a",
    surface: "#090909",
    selected: "#161616",
    ink: "#fafafa",
    muted: "#a3a3a3",
    mutedInk: "#c5c5c5",
    faint: "#777777",
    border: "#292929",
    strong: "#4a4a4a",
    button: "#f5f5f5",
    buttonInk: "#101010",
    blue: "#65b7f0",
    ring: "#a1a1a1",
    blueFill: "#132a3b",
    green: "#52bb81",
    greenFill: "#16291e",
    amber: "#e0aa53",
    amberFill: "#302618",
    warning: "#de9300",
    warningInk: "#de9300",
    red: "#ff6874",
    redFill: "#3a1d21",
  },
};

export const parts = {
  sidebar: { radius: 0, backgroundOpacity: 0.9 },
  panel: { radius: 0, backgroundOpacity: 0.92 },
  messageBubble: { radius: 14, backgroundOpacity: 0.94 },
  composer: { radius: 14, backgroundOpacity: 0.97 },
  card: { radius: 12, backgroundOpacity: 0.94 },
  button: { radius: 8 },
  dialog: { radius: 16, backgroundOpacity: 0.99 },
};

export const studioPreset = {
  version: 1,
  name: "雾蓝",
  base: "dark",
  colors: {
    canvas: "#111c2b",
    surface: "#1b2b40",
    selected: "#2a3d56",
    ink: "#eef4fb",
    muted: "#aabbd0",
    mutedInk: "#c1cde0",
    faint: "#8ea4bf",
    border: "#3d5470",
    strong: "#59708a",
    button: "#b3dbed",
    buttonInk: "#152638",
    blue: "#9bc9eb",
    ring: "#b3dbed",
    blueFill: "#24425a",
    green: "#91dfb4",
    greenFill: "#1d4235",
    amber: "#f6c979",
    amberFill: "#493920",
    warning: "#f1b76e",
    warningInk: "#f1b76e",
    red: "#fda5a7",
    redFill: "#533239",
  },
  wallpaper: { fit: "cover", overlayOpacity: 0.38 },
  components: parts,
};

const colorPattern = /^#[0-9a-f]{6}$/i;
const fits = new Set(["cover", "contain", "fill"]);
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const number = (value, fallback, min, max) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;

export function normalizeTheme(input) {
  const source = object(input);
  if (source.version !== 1) throw new Error("该主题文件的版本不受支持。");
  const base = source.base === "light" ? "light" : "dark";
  const colors = {};
  for (const key of Object.keys(palettes[base])) {
    const value = object(source.colors)[key];
    if (typeof value === "string" && colorPattern.test(value))
      colors[key] = value.toLowerCase();
  }

  const wallpaper = object(source.wallpaper);
  const file =
    typeof wallpaper.file === "string" &&
    /^wallpaper\.(?:png|jpg|gif|webp)$/.test(wallpaper.file)
      ? wallpaper.file
      : undefined;
  const components = {};
  for (const [key, defaults] of Object.entries(parts)) {
    const values = object(object(source.components)[key]);
    components[key] = { radius: number(values.radius, defaults.radius, 0, 32) };
    if (defaults.backgroundOpacity !== undefined) {
      components[key].backgroundOpacity = number(
        values.backgroundOpacity,
        defaults.backgroundOpacity,
        0,
        1,
      );
    }
  }
  return {
    version: 1,
    name:
      typeof source.name === "string" && source.name.trim()
        ? source.name.trim().slice(0, 64)
        : "自定义主题",
    base,
    colors,
    wallpaper: {
      ...(file ? { file } : {}),
      fit: fits.has(wallpaper.fit) ? wallpaper.fit : "cover",
      overlayOpacity: number(wallpaper.overlayOpacity, 0.38, 0, 1),
    },
    components,
  };
}

export function defaultTheme() {
  return normalizeTheme(studioPreset);
}

export function resolveColors(theme) {
  return { ...palettes[theme.base], ...theme.colors };
}

export function checkedImage(bytes) {
  if (!bytes.length || bytes.length > imageLimit)
    throw new Error("请选择一张不超过 4 MB 的图片。");
  const start = (sequence, offset = 0) =>
    sequence.every((byte, index) => bytes[offset + index] === byte);
  if (start([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { file: "wallpaper.png", mime: "image/png" };
  if (start([0xff, 0xd8, 0xff]))
    return { file: "wallpaper.jpg", mime: "image/jpeg" };
  if (
    start([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    start([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  )
    return { file: "wallpaper.gif", mime: "image/gif" };
  if (start([0x52, 0x49, 0x46, 0x46]) && start([0x57, 0x45, 0x42, 0x50], 8))
    return { file: "wallpaper.webp", mime: "image/webp" };
  throw new Error("请选择 PNG、JPEG、GIF 或 WebP 图片。");
}

export function validImageUrl(value) {
  return (
    typeof value === "string" &&
    value.length <= Math.ceil(imageLimit / 3) * 4 + 32 &&
    /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(
      value,
    ) &&
    (value.length - value.indexOf(",") - 1) % 4 === 0
  );
}

export function showWallpaper(image, reducedMotion) {
  if (!validImageUrl(image)) return false;
  if (!reducedMotion || image.startsWith("data:image/jpeg;")) return true;
  if (image.startsWith("data:image/gif;")) return false;
  const data = image.slice(image.indexOf(",") + 1);
  if (image.startsWith("data:image/webp;")) {
    const header = atob(data.slice(0, 28));
    return header.slice(12, 16) !== "VP8X" || !(header.charCodeAt(20) & 2);
  }
  return !atob(data).includes("acTL");
}

export function webOrigin(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export function sitePattern(origin) {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}
