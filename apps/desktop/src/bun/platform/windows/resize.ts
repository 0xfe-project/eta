/**
 * The border a frameless window loses.
 *
 * `titleBarStyle: "hidden"` takes the title bar away and the resize frame with it: a window you
 * cannot grab by its edges is a window that has one size forever. `WS_THICKFRAME` puts the edge
 * hit-testing back, and `SetWindowPos` with `SWP_FRAMECHANGED` is what makes Windows believe the
 * new style now rather than at the next move — without it the style is set and ignored.
 */
import type { WindowHandle } from "./native";
import {
  GWL_STYLE,
  SWP_FRAMECHANGED_ONLY,
  user32Symbols,
  WS_THICKFRAME,
} from "./native";

export function enableResizeBorder(hwnd: WindowHandle): void {
  const user32 = user32Symbols();
  const style = user32.GetWindowLongPtrW(hwnd, GWL_STYLE);
  // Zero is not a style a real window has — it is the call failing, and writing
  // `0 | WS_THICKFRAME` back would strip every other style bit the window had.
  if (style === 0n)
    throw new Error("window_style_unreadable: GetWindowLongPtrW returned 0");
  // Already thick-framed: the window can be resized, and the refresh below would be noise.
  if ((style & WS_THICKFRAME) !== 0n) return;
  user32.SetWindowLongPtrW(hwnd, GWL_STYLE, style | WS_THICKFRAME);
  if (user32.SetWindowPos(hwnd, null, 0, 0, 0, 0, SWP_FRAMECHANGED_ONLY) === 0)
    throw new Error("window_frame_refresh_failed: SetWindowPos returned 0");
}
