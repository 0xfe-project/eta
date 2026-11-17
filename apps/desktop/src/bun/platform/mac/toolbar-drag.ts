import type { BrowserWindow } from "electrobun/main";
import { join } from "node:path";
import { dlopen, FFIType } from "bun:ffi";
import Electrobun, { PATHS } from "electrobun/main";
import { toolbarDragBounds } from "./toolbar-drag-preload";

function openGuard() {
  return dlopen(join(PATHS.VIEWS_FOLDER, "mainview", "libToolbarDrag.dylib"), {
    etaInstallToolbarDragGuard: { args: [FFIType.ptr], returns: FFIType.void },
    etaSetToolbarDragBounds: {
      args: [
        FFIType.ptr,
        FFIType.double,
        FFIType.double,
        FFIType.double,
        FFIType.double,
      ],
      returns: FFIType.void,
    },
    etaRemoveToolbarDragGuard: { args: [FFIType.ptr], returns: FFIType.void },
  });
}

let guard: ReturnType<typeof openGuard> | undefined;

export function configureToolbarDrag(
  window: BrowserWindow,
  token: string,
): void {
  guard ??= openGuard();
  const { symbols } = guard;
  const pointer = window.ptr;
  symbols.etaInstallToolbarDragGuard(pointer);
  const receive = (event: unknown) => {
    if (
      typeof event !== "object" ||
      event === null ||
      !("data" in event) ||
      typeof event.data !== "object" ||
      event.data === null ||
      !("detail" in event.data)
    )
      return;
    const bounds = toolbarDragBounds(event.data.detail, token, window.id);
    if (bounds) symbols.etaSetToolbarDragBounds(pointer, ...bounds);
  };
  Electrobun.events.on("host-message", receive);
  window.webview.on("did-commit-navigation", () => {
    symbols.etaSetToolbarDragBounds(pointer, 0, 0, 0, 0);
    window.webview.executeJavascript(
      "window.dispatchEvent(new Event('eta-toolbar-drag-refresh'));",
    );
  });
  window.on("close", () => {
    Electrobun.events.off("host-message", receive);
    symbols.etaRemoveToolbarDragGuard(pointer);
  });
}
