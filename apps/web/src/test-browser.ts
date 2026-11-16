import type { Browser, BrowserContextOptions, Page } from "playwright-core";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";

/**
 * The cascade, settled by a real browser: happy-dom resolves no `@layer`, no `:hover` and no
 * media query, so a test that asks it whether a rule wins only reads the rule back. Here the
 * app's own `styles.css` is compiled by Tailwind exactly as Vite would, put on a page in headless
 * Chromium next to the markup a happy-dom test rendered, and the test asks that page.
 *
 * Chromium is Playwright's (`bunx playwright-core install chromium-headless-shell`), or the
 * system Chrome a CI runner already has. With neither, the tests that need it are skipped
 * locally and fail on CI.
 */

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function packageStylesheet(id: string): string {
  const parts = id.split("/");
  const name = id.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  const sub = id.slice(name.length);
  const root = join(WEB, "node_modules", name);
  const manifest = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as {
    exports?: Record<string, string | Record<string, string>>;
    style?: string;
  };
  const entry = manifest.exports?.[sub ? `.${sub}` : "."];
  const file =
    typeof entry === "string"
      ? entry
      : (entry?.style ?? entry?.default ?? (sub ? `.${sub}` : manifest.style));
  if (!file) throw new Error(`no stylesheet for ${id}`);
  return join(root, file);
}

let compiled: ReturnType<typeof compile> | undefined;
function compiler() {
  compiled ??= compile(readFileSync(join(WEB, "src/styles.css"), "utf8"), {
    base: join(WEB, "src"),
    loadStylesheet: async (id, base) => {
      const path = id.startsWith(".")
        ? resolve(base, id)
        : packageStylesheet(id);
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });
  return compiled;
}

/** The app's stylesheet with the utilities `markup` uses, as the build would emit them. */
async function appStyles(markup: string): Promise<string> {
  const candidates = new Set<string>();
  for (const [, list] of markup.matchAll(/class="([^"]*)"/g)) {
    for (const name of list!.split(/\s+/)) if (name) candidates.add(name);
  }
  return (await compiler()).build([...candidates]);
}

let launched: Promise<Browser | undefined> | undefined;
function browser() {
  launched ??= (async () => {
    const { chromium } = await import("playwright-core");
    const attempts = [
      () => chromium.launch(),
      () => chromium.launch({ channel: "chrome" }),
      ...[
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
      ]
        .filter((path) => existsSync(path))
        .map((executablePath) => () => chromium.launch({ executablePath })),
    ];
    for (const attempt of attempts) {
      try {
        return await attempt();
      } catch {
        /* the next one */
      }
    }
    if (process.env.CI) throw new Error("no Chromium for the cascade tests");
    return undefined;
  })();
  return launched;
}

/** Whether a browser is there; tests that need one are skipped without it (never on CI). */
export async function hasBrowser(): Promise<boolean> {
  return (await browser()) !== undefined;
}

export async function closeBrowser(): Promise<void> {
  const open = await launched;
  launched = undefined;
  await open?.close();
}

/** A phone: 390px wide, touch, no hover — `(hover: none), (pointer: coarse)` both match. */
export const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};
const DESKTOP: BrowserContextOptions = {
  viewport: { width: 1280, height: 800 },
};

/**
 * Open `markup` (what a happy-dom test rendered) on a page styled by the real stylesheet, and
 * hand the page to `visit`. The page's color scheme is light and its `<html>` carries no theme class,
 * the same as the app's first paint.
 */
export async function onPage<T>(
  markup: string,
  visit: (page: Page) => Promise<T>,
  context: BrowserContextOptions = DESKTOP,
): Promise<T> {
  const open = await browser();
  if (!open) throw new Error("no browser: check hasBrowser() first");
  const ctx = await open.newContext(context);
  try {
    const page = await ctx.newPage();
    await page.setContent(
      `<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${await appStyles(markup)}</style></head><body>${markup}</body></html>`,
    );
    return await visit(page);
  } finally {
    await ctx.close();
  }
}
