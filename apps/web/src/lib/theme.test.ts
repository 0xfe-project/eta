import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { setTheme, TITLE_BAR_COLORS } from "./theme";

// The title bar of the installed app: index.html's two theme-color metas, and what the app does
// to them when the mode changes.
const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const page = new DOMParser().parseFromString(html, "text/html");
const manifest = JSON.parse(
  readFileSync(
    new URL("../../public/manifest.webmanifest", import.meta.url),
    "utf8",
  ),
) as { theme_color: string; background_color: string };

/** The inline script in index.html that sets the mode before the bundle loads. */
const bootScript = [...page.querySelectorAll("script:not([src])")]
  .map((node) => node.textContent ?? "")
  .find((text) => text.includes('localStorage.getItem("theme")'));

function bars() {
  return [
    ...document.head.querySelectorAll<HTMLMetaElement>(
      'meta[name="theme-color"]',
    ),
  ].map((meta) => ({
    media: meta.getAttribute("media") ?? "",
    content: meta.getAttribute("content") ?? "",
  }));
}

/** Run index.html's inline script the way a fresh load does. */
function runBootScript() {
  // eslint-disable-next-line no-new-func -- the script under test is text read from index.html
  new Function(bootScript ?? "")();
}

/** The browser's answer for the page as it is, given the system mode. */
function shownColor(system: "light" | "dark") {
  return bars().find((bar) => bar.media.includes(system))?.content;
}

let systemDark = false;
const realMatchMedia = window.matchMedia;

/** The head as index.html ships it. */
function freshHead() {
  for (const meta of document.head.querySelectorAll('meta[name="theme-color"]'))
    meta.remove();
  for (const meta of page.querySelectorAll('meta[name="theme-color"]'))
    document.head.append(document.importNode(meta, true));
}

beforeEach(() => {
  freshHead();
  localStorage.clear();
  systemDark = false;
  window.matchMedia = ((query: string) =>
    ({
      matches: query.includes("dark") && systemDark,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  document.documentElement.classList.remove("dark");
});

describe("标题栏颜色", () => {
  it("ships one meta per system mode, in the colors of the top band", () => {
    expect(bars()).toEqual([
      {
        media: "(prefers-color-scheme: light)",
        content: TITLE_BAR_COLORS.light,
      },
      {
        media: "(prefers-color-scheme: dark)",
        content: TITLE_BAR_COLORS.dark,
      },
    ]);
  });

  it("gives the manifest the light bar and the light page", () => {
    expect(manifest.theme_color).toBe(TITLE_BAR_COLORS.light);
    // background_color is the window before the page paints: --background, white.
    expect(manifest.background_color).toBe("#ffffff");
  });

  it("follows a mode chosen in the app, whatever the system is", () => {
    setTheme("dark");
    expect(shownColor("light")).toBe(TITLE_BAR_COLORS.dark);
    expect(shownColor("dark")).toBe(TITLE_BAR_COLORS.dark);

    setTheme("light");
    expect(shownColor("light")).toBe(TITLE_BAR_COLORS.light);
    expect(shownColor("dark")).toBe(TITLE_BAR_COLORS.light);
  });

  it("hands the choice back to the media queries on system", () => {
    setTheme("dark");
    setTheme("system");
    expect(bars()).toEqual([
      {
        media: "(prefers-color-scheme: light)",
        content: TITLE_BAR_COLORS.light,
      },
      {
        media: "(prefers-color-scheme: dark)",
        content: TITLE_BAR_COLORS.dark,
      },
    ]);
  });

  it("is already right before the bundle loads", () => {
    expect(bootScript).toBeDefined();
    localStorage.setItem("theme", "dark");
    runBootScript();
    expect(shownColor("light")).toBe(TITLE_BAR_COLORS.dark);
    expect(shownColor("dark")).toBe(TITLE_BAR_COLORS.dark);

    // A fresh load: the script runs once, on the metas as shipped.
    freshHead();
    localStorage.setItem("theme", "light");
    runBootScript();
    expect(shownColor("dark")).toBe(TITLE_BAR_COLORS.light);
  });

  it("leaves the metas alone at boot when following the system", () => {
    systemDark = true;
    runBootScript();
    expect(shownColor("light")).toBe(TITLE_BAR_COLORS.light);
    expect(shownColor("dark")).toBe(TITLE_BAR_COLORS.dark);
  });
});
