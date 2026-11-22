import { etaPalettes, roles } from "./eta-palettes.js";
import { resolveColors, showWallpaper } from "./theme.js";

export const appSelector = '[data-testid="app-safe-area"]';
const scope = ":root[data-eta-theme]";
const messageList = '[data-testid="conversation-messages"]';
const surfaceSelectors = {
  sidebar: `${appSelector} .nsh-v:has(> nav)`,
  panel: `${appSelector} .nsh-v:has(> [role="slider"]):not(:has(> nav)) > .nsh-v:not([role="slider"])`,
  messageBubble: `${messageList} :is(.nsh-area:has(> .nsh-border),[data-testid="reply-answer"])`,
  composer: '[data-testid="conversation-composer"]',
  card: `${appSelector} :is([data-testid="process-window"],[role="button"].nsh-pan)`,
  button: ':is(button,[role="button"])',
  dialog: '[role="dialog"]',
};

const paintRoles = [
  [
    ["background-color"],
    [
      "canvas",
      "surface",
      "selected",
      "button",
      "blueFill",
      "greenFill",
      "amberFill",
      "redFill",
    ],
  ],
  [
    ["color", "fill", "stroke"],
    [
      "ink",
      "muted",
      "mutedInk",
      "faint",
      "buttonInk",
      "blue",
      "green",
      "amber",
      "warningInk",
      "warning",
      "red",
    ],
  ],
  [
    [
      "border-color",
      "border-top-color",
      "border-right-color",
      "border-bottom-color",
      "border-left-color",
    ],
    ["border", "strong", "warning"],
  ],
  [["outline-color"], ["ring"]],
];

const encodedIcon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path fill="#')}`;

export function isEtaIconSource(source) {
  return (
    source?.startsWith(encodedIcon) && source.endsWith("%2F%3E%3C%2Fsvg%3E")
  );
}

function variants(hex) {
  const bytes = hex
    .match(/[\da-f]{2}/g)
    ?.map((byte) => Number.parseInt(byte, 16));
  return bytes?.length === 3 ? [hex, `rgb(${bytes.join(", ")})`] : [hex];
}

function originalPalette(canvas) {
  const matched = etaPalettes.filter((palette) =>
    variants(palette[0]).includes(canvas),
  );
  return matched.length ? matched : etaPalettes.slice(0, 2);
}

function translatePaint(canvas, wallpaper) {
  const sources = originalPalette(canvas);
  const paints = new Map();
  for (const [properties, names] of paintRoles) {
    for (const property of properties) {
      const translations = new Map();
      for (const name of names) {
        const layer =
          wallpaper &&
          property === "background-color" &&
          (name === "canvas" || name === "surface");
        const replacement = `var(--eta-${layer ? "layer-" : ""}${name})`;
        for (const palette of sources) {
          for (const value of variants(palette[roles.indexOf(name)])) {
            if (!translations.has(value)) translations.set(value, replacement);
          }
        }
      }
      paints.set(property, translations);
    }
  }
  return paints;
}

function paintRules(canvas, wallpaper, nativeRules) {
  const paints = translatePaint(canvas, wallpaper);
  const rules = [];
  for (const [property, translations] of paints) {
    for (const [value, replacement] of translations) {
      const inline = `:is([style^="${property}: ${value};"],[style*="; ${property}: ${value};"])`;
      rules.push(`${scope} ${inline}{${property}:${replacement}!important}`);
    }
  }
  for (const rule of nativeRules) {
    const declarations = [];
    for (const [property, translations] of paints) {
      const original = rule.style.getPropertyValue(property);
      const replacement = translations.get(original);
      if (replacement)
        declarations.push(`${property}:${replacement}!important`);
    }
    if (declarations.length)
      rules.push(
        `${scope} :is(${rule.selectorText}){${declarations.join(";")}}`,
      );
  }
  return rules.join("\n");
}

function iconRules(sources, canvas, colors) {
  const paint = new Map();
  for (const palette of originalPalette(canvas)) {
    for (const role of paintRoles[1][1]) {
      const original = palette[roles.indexOf(role)]?.slice(1);
      if (original && !paint.has(original))
        paint.set(original, colors[role].slice(1));
    }
  }
  const rules = [];
  for (const [url, source] of sources) {
    if (!isEtaIconSource(source)) continue;
    const base = source.slice(encodedIcon.length, encodedIcon.length + 6);
    const next = paint.get(base);
    if (!next || base === next) continue;
    const updated = encodedIcon + next + source.slice(encodedIcon.length + 6);
    rules.push(
      `${scope} .nsh-root img[src=${JSON.stringify(url)}]{content:url(${JSON.stringify(updated)})!important}`,
    );
  }
  return rules.join("\n");
}

const alpha = (token, value) =>
  `color-mix(in srgb, var(--eta-${token}) ${(value * 100).toFixed(1)}%, transparent)`;
const withScope = (selector) => `${scope} ${selector}`;

export function stylesheet(
  theme,
  image,
  originalCanvas,
  reducedMotion,
  nativeRules = [],
  icons = [],
) {
  const visibleImage = showWallpaper(image, reducedMotion);
  const colors = resolveColors(theme);
  const variables = Object.entries(colors).map(
    ([role, color]) => `--eta-${role}:${color}`,
  );
  variables.push(
    `--eta-layer-canvas:${alpha("canvas", 0.6)}`,
    `--eta-layer-surface:${alpha("surface", theme.components.panel.backgroundOpacity)}`,
  );
  const rules = [
    "@layer eta-components, eta-palette;",
    `${scope}{${variables.join(";")}}`,
    `@layer eta-palette{${paintRules(originalCanvas, visibleImage, nativeRules)}\n${iconRules(icons, originalCanvas, colors)}}`,
    "@layer eta-components{",
  ];
  const root = withScope(appSelector);
  rules.push(
    `${root}{background-color:var(--eta-canvas)!important;color:var(--eta-ink)!important}`,
  );
  if (visibleImage) {
    const position =
      theme.wallpaper.fit === "fill" ? "100% 100%" : theme.wallpaper.fit;
    const scrim = alpha("canvas", theme.wallpaper.overlayOpacity);
    rules.push(
      `${root}{background-image:linear-gradient(${scrim},${scrim}),url("${image}")!important;background-position:center!important;background-size:${position}!important;background-repeat:no-repeat!important}`,
    );
  }

  // The rules for individual surfaces follow the palette rules so they win in the cascade.
  for (const [part, selector] of Object.entries(surfaceSelectors)) {
    const values = theme.components[part];
    const selected = withScope(selector);
    const radius = `border-radius:${values.radius}px!important`;
    if (part === "button") {
      rules.push(`${selected}{${radius}}`);
    } else {
      const targetColor = part === "composer" ? "canvas" : "surface";
      const background = alpha(targetColor, values.backgroundOpacity);
      rules.push(
        `${selected}{${radius};background-color:${background}!important;border-color:var(--eta-border)!important}`,
      );
    }
    rules.push(`${selected}>.nsh-border{border-radius:inherit!important}`);
  }
  rules.push(
    `${scope} a,${scope} [role="link"]{color:var(--eta-blue)!important}`,
    `${scope} :is(a,button,[role="button"],input,textarea,[tabindex]):focus-visible{outline-color:var(--eta-ring)!important}`,
  );
  return [...rules, "}"].join("\n");
}
