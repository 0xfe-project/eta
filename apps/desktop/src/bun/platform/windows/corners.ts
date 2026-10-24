/**
 * Square corners on Windows 11, which rounds every window by default.
 *
 * The page's geometry is square — the bands, the panes, the rules between them — and a rounded
 * window frame is a second, softer shape around all of it. `DwmSetWindowAttribute` 33 asks for
 * "do not round" and is the whole patch.
 *
 * On Windows 10 the call answers `E_INVALIDARG`, because there is nothing to un-round there. The
 * failure is still reported: this file cannot tell "old Windows" from "DWM said no", and a patch
 * that failed silently looks exactly like one that worked.
 */
import type { WindowHandle } from "./native";
import { Buffer } from "node:buffer";
import {
  dwmapiSymbols,
  DWMWA_WINDOW_CORNER_PREFERENCE,
  DWMWCP_DONOTROUND,
} from "./native";

export function squareWindowCorners(hwnd: WindowHandle): void {
  const preference = Buffer.from([DWMWCP_DONOTROUND, 0, 0, 0]);
  const result = dwmapiSymbols().DwmSetWindowAttribute(
    hwnd,
    DWMWA_WINDOW_CORNER_PREFERENCE,
    preference,
    preference.length,
  );
  if (result !== 0)
    throw new Error(
      `window_corners_failed: DwmSetWindowAttribute returned 0x${(result >>> 0).toString(16)}`,
    );
}
