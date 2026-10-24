/**
 * Windows-only window chrome, called by the main process on win32 and nowhere else.
 *
 * A frameless window is the platform's job done by hand. Electrobun's `titleBarStyle: "hidden"`
 * removes the title bar and, with it, three things the platform used to provide:
 *
 * - a border you can resize the window by (`resize.ts`),
 * - square corners (`corners.ts`) — Windows 11 rounds everything by default,
 * - an icon on the real HWND (`icon.ts`) — the packaged ICO covers shortcuts, not the window.
 *
 * None of them are decoration: without the first the window cannot be resized at all, and without
 * the third the app wears the runtime's generic icon in its own title bar.
 *
 * The native handle is looked up once (`native.ts`) and handed to all three. Failures are
 * reported — a patch that cannot run leaves the window broken in one specific way, and a silent
 * no-op makes that indistinguishable from working. None of them are worth refusing to open the
 * window over: a window that resizes but is round is still a usable app.
 */
import type { BrowserWindow } from "electrobun/main";
import type { WindowHandle } from "./native";
import { join } from "node:path";
import { PATHS } from "electrobun/main";
import { squareWindowCorners } from "./corners";
import { setWindowIcon } from "./icon";
import { windowHandle } from "./native";
import { enableResizeBorder } from "./resize";

/**
 * Where `electrobun.config.ts` copies the ICO: beside the views, which is what a packaged app
 * has — there is no checkout to read it from.
 */
const WINDOW_ICON = join(PATHS.VIEWS_FOLDER, "mainview", "Eta-Logo.ico");

function report(patch: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`[eta-desktop] windows/${patch}: ${reason}`);
}

export async function configureWindowsWindow(
  window: BrowserWindow,
): Promise<void> {
  let hwnd: WindowHandle;
  try {
    hwnd = await windowHandle(window.title);
  } catch (error) {
    // Nothing below can run without it, and they would all fail with the same reason.
    report("handle", error);
    return;
  }
  const patches: readonly (readonly [string, () => unknown])[] = [
    ["resize", () => enableResizeBorder(hwnd)],
    ["corners", () => squareWindowCorners(hwnd)],
    ["icon", () => setWindowIcon(hwnd, WINDOW_ICON)],
  ];
  for (const [name, patch] of patches) {
    try {
      patch();
    } catch (error) {
      report(name, error);
    }
  }
}
