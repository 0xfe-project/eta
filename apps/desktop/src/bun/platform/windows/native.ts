/**
 * The two Windows libraries this shell talks to, and the one way it finds its own window.
 *
 * Everything here is loaded lazily, on first use, and only ever from `platform/windows/index.ts`
 * — which the main process calls on win32 alone. `user32.dll` does not exist on macOS, so a
 * `dlopen` at import time would take the whole shell down on the machine most of this code is
 * developed on, for a capability that machine already has.
 */
import type { Pointer } from "bun:ffi";
import { Buffer } from "node:buffer";
import { dlopen, FFIType } from "bun:ffi";

/** What `FindWindowA` hands back: an address, which Bun types as either a pointer or a bigint. */
export type WindowHandle = Pointer | bigint;

/** `GetWindowLongPtrW`'s index of the style word; the only one any patch here reads. */
export const GWL_STYLE = -16;

/** The style bit that makes a frameless window resizable by its edges. */
export const WS_THICKFRAME = 0x0004_0000n;

/**
 * `SetWindowPos` without moving, resizing, restacking or activating: the call is only there so
 * Windows recomputes the frame after the style bit changed (`SWP_FRAMECHANGED`).
 */
export const SWP_FRAMECHANGED_ONLY = 0x0037;

/** `DwmSetWindowAttribute`'s "how round are my corners" and its "not at all" answer. */
export const DWMWA_WINDOW_CORNER_PREFERENCE = 33;
export const DWMWCP_DONOTROUND = 1;

export const WM_SETICON = 0x0080;
export const ICON_SMALL = 0;
export const ICON_BIG = 1;
export const IMAGE_ICON = 1;
/** `LR_LOADFROMFILE`: `LoadImageA`'s second argument is a file path, not a resource id. */
export const LR_LOADFROMFILE = 0x0010;

// The declarations, not the libraries: `dlopen` runs the first time a patch asks for one.
function loadUser32() {
  return dlopen("user32.dll", {
    FindWindowA: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.ptr },
    GetWindowLongPtrW: {
      args: [FFIType.ptr, FFIType.i32],
      returns: FFIType.i64,
    },
    SetWindowLongPtrW: {
      args: [FFIType.ptr, FFIType.i32, FFIType.i64],
      returns: FFIType.i64,
    },
    SetWindowPos: {
      args: [
        FFIType.ptr,
        FFIType.ptr,
        FFIType.i32,
        FFIType.i32,
        FFIType.i32,
        FFIType.i32,
        FFIType.u32,
      ],
      returns: FFIType.i32,
    },
    LoadImageA: {
      args: [
        FFIType.ptr,
        FFIType.cstring,
        FFIType.u32,
        FFIType.i32,
        FFIType.i32,
        FFIType.u32,
      ],
      returns: FFIType.ptr,
    },
    SendMessageW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.ptr,
    },
  });
}

function loadDwmapi() {
  return dlopen("dwmapi.dll", {
    DwmSetWindowAttribute: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
  });
}

let user32: ReturnType<typeof loadUser32> | undefined;
let dwmapi: ReturnType<typeof loadDwmapi> | undefined;

export function user32Symbols(): ReturnType<typeof loadUser32>["symbols"] {
  user32 ??= loadUser32();
  return user32.symbols;
}

export function dwmapiSymbols(): ReturnType<typeof loadDwmapi>["symbols"] {
  dwmapi ??= loadDwmapi();
  return dwmapi.symbols;
}

/** How long to keep looking for the window before saying it is not there. */
const HANDLE_TIMEOUT_MS = 3_000;
const HANDLE_RETRY_MS = 50;

/**
 * The native handle of the window this process created, found by its title.
 *
 * Electrobun keeps the HWND to itself, so asking Windows for the window by name is the only way
 * in. That lookup lives here, once: three patches each writing their own copy is three places to
 * forget the day the title changes, and each copy would fail differently and quietly.
 *
 * The native window is created after `new BrowserWindow(...)` has already returned, so the first
 * looks legitimately find nothing — this waits for it instead of giving up on the first miss, and
 * throws when it never shows. A patch with no window to patch must not report success.
 *
 * A second shell running at the same time shares the title, and this would find whichever window
 * Windows lists first. Two shells at once means two hosts over one `~/.eta`, which is not a state
 * the app supports — a unique-per-run title would mean a title the window itself does not carry.
 */
export async function windowHandle(title: string): Promise<WindowHandle> {
  const wanted = Buffer.from(`${title}\0`);
  const deadline = Date.now() + HANDLE_TIMEOUT_MS;
  for (;;) {
    const found = user32Symbols().FindWindowA(null, wanted);
    if (found !== null) return found;
    if (Date.now() > deadline)
      throw new Error(
        `window_handle_missing: no window titled "${title}" after ${String(HANDLE_TIMEOUT_MS)}ms`,
      );
    await Bun.sleep(HANDLE_RETRY_MS);
  }
}
