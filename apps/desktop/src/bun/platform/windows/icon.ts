/**
 * The icon Windows shows for this window, on the window itself.
 *
 * The packaged ICO (`win.icon` in `electrobun.config.ts`) is what Explorer, the installer and a
 * pinned shortcut wear. The window a running process owns is a separate thing: nothing in
 * Electrobun's API sets its icon, so the title bar and the taskbar entry of the live window fall
 * back to the runtime's generic icon. `WM_SETICON` is the only way to hand an HWND an icon, and it
 * wants two of them — 16px for the title bar, 32px for the taskbar and Alt-Tab.
 *
 * The path is inside the bundle's views, not the checkout: a packaged app has no checkout.
 */
import type { Pointer } from "bun:ffi";
import type { WindowHandle } from "./native";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import {
  ICON_BIG,
  ICON_SMALL,
  IMAGE_ICON,
  LR_LOADFROMFILE,
  user32Symbols,
  WM_SETICON,
} from "./native";

const SMALL_PX = 16;
const BIG_PX = 32;

export function setWindowIcon(hwnd: WindowHandle, iconPath: string): void {
  if (!existsSync(iconPath))
    throw new Error(`window_icon_missing: ${iconPath} is not in the bundle`);
  const user32 = user32Symbols();
  const path = Buffer.from(`${iconPath}\0`);
  const load = (size: number): Pointer | bigint | null =>
    user32.LoadImageA(null, path, IMAGE_ICON, size, size, LR_LOADFROMFILE);
  const small = load(SMALL_PX);
  const big = load(BIG_PX);
  if (small === null || big === null)
    throw new Error(
      `window_icon_unreadable: LoadImageA failed for ${iconPath}`,
    );
  user32.SendMessageW(hwnd, WM_SETICON, ICON_SMALL, small);
  user32.SendMessageW(hwnd, WM_SETICON, ICON_BIG, big);
}
